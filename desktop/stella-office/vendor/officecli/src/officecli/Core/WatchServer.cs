// Copyright 2025 OfficeCli (officecli.ai)
// SPDX-License-Identifier: Apache-2.0

using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace OfficeCli.Core;

/// <summary>
/// Pure SSE relay server. Never opens the document file.
/// Receives pre-rendered HTML from command processes via named pipe,
/// forwards to browsers via SSE.
/// </summary>
public class WatchServer : IDisposable
{
    private readonly string _filePath;
    private readonly string _pipeName;
    private readonly int _port;
    private readonly TcpListener _tcpListener;
    private readonly List<NetworkStream> _sseClients = new();
    private readonly object _sseLock = new();
    private CancellationTokenSource _cts = new();
    private string _currentHtml = "";
    private int _version = 0;
    private bool _disposed;
    private DateTime _lastActivityTime = DateTime.UtcNow;
    private readonly TimeSpan _idleTimeout;

    private const string WaitingHtml = """
        <html><head><meta charset="utf-8"><title>Watching...</title>
        <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;color:#666;}
        .msg{text-align:center;}</style></head>
        <body><div class="msg"><h2>Waiting for first update...</h2><p>Run an officecli command to see the preview.</p></div></body></html>
        """;

    private const string SseScript = """
        <script>
        (function() {
            var es = new EventSource('/events');
            var _scrollTimer = null;
            function scrollToSlide(num) {
                clearTimeout(_scrollTimer);
                _scrollTimer = setTimeout(function() {
                    var target = document.querySelector('.slide-container[data-slide="' + num + '"]');
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 300);
            }
            function syncThumbs() {
                var sidebar = document.querySelector('.sidebar');
                if (!sidebar) return;
                var slides = document.querySelectorAll('.main > .slide-container');
                var thumbs = sidebar.querySelectorAll('.thumb');
                // Remove extra thumbs
                for (var i = thumbs.length - 1; i >= slides.length; i--) {
                    thumbs[i].remove();
                }
                // Add missing thumbs
                for (var i = thumbs.length; i < slides.length; i++) {
                    var thumb = document.createElement('div');
                    thumb.className = 'thumb';
                    thumb.setAttribute('data-slide', i + 1);
                    thumb.innerHTML = '<div class="thumb-inner"></div><span class="thumb-num">' + (i + 1) + '</span>';
                    sidebar.appendChild(thumb);
                }
                // Renumber all thumbs
                sidebar.querySelectorAll('.thumb').forEach(function(t, i) {
                    t.setAttribute('data-slide', i + 1);
                    var num = t.querySelector('.thumb-num');
                    if (num) num.textContent = i + 1;
                });
                // Clear all thumb clones so buildThumbs re-creates them fresh
                sidebar.querySelectorAll('.thumb-inner').forEach(function(inner) {
                    var old = inner.querySelector('.thumb-slide');
                    if (old) old.remove();
                });
                if (typeof buildThumbs === 'function') buildThumbs();
                // Update page counter
                var counter = document.querySelector('.page-counter');
                if (counter) counter.textContent = '1 / ' + slides.length;
            }
            // Word diff-update: de-paginate, diff children, re-paginate (no full innerHTML swap)
            function wordDiffUpdate(msg) {
                var visiblePageNum = 0;
                document.querySelectorAll('.page-wrapper').forEach(function(w) {
                    var rect = w.getBoundingClientRect();
                    if (rect.top < window.innerHeight / 2) {
                        var p = w.querySelector('.page');
                        if (p) visiblePageNum = parseInt(p.getAttribute('data-page')) || 0;
                    }
                });
                fetch('/').then(function(r) { return r.text(); }).then(function(html) {
                    var doc = new DOMParser().parseFromString(html, 'text/html');
                    // Update styles
                    var oldStyles = document.querySelectorAll('head style');
                    var newStyles = doc.querySelectorAll('head style');
                    oldStyles.forEach(function(s) { s.remove(); });
                    newStyles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });
                    // De-paginate: merge pagination-created pages back into section wrappers
                    var allW = Array.from(document.querySelectorAll('.page-wrapper'));
                    var curSec = null;
                    allW.forEach(function(w) {
                        if (w.hasAttribute('data-section')) { curSec = w; return; }
                        if (!curSec) return;
                        var src = w.querySelector('.page-body');
                        var dst = curSec.querySelector('.page-body');
                        if (src && dst) {
                            Array.from(src.children).forEach(function(c) {
                                if (!c.classList.contains('footnotes')) dst.appendChild(c);
                            });
                        }
                        w.remove();
                    });
                    // Diff per section
                    var contentAdded = false;
                    var oldSecs = Array.from(document.querySelectorAll('.page-wrapper[data-section]'));
                    var newSecs = Array.from(doc.querySelectorAll('.page-wrapper[data-section]'));
                    var maxS = Math.max(oldSecs.length, newSecs.length);
                    for (var si = 0; si < maxS; si++) {
                        if (si >= oldSecs.length) {
                            // New section added
                            var last = document.querySelector('.page-wrapper[data-section]:last-of-type');
                            if (last) last.after(newSecs[si].cloneNode(true));
                            continue;
                        }
                        if (si >= newSecs.length) { oldSecs[si].remove(); continue; }
                        var oldB = oldSecs[si].querySelector('.page-body');
                        var newB = newSecs[si].querySelector('.page-body');
                        if (!oldB || !newB) continue;
                        var oldK = Array.from(oldB.children).filter(function(c){ return !c.classList.contains('footnotes'); });
                        var newK = Array.from(newB.children).filter(function(c){ return !c.classList.contains('footnotes'); });
                        // Common prefix
                        var pi = 0;
                        while (pi < oldK.length && pi < newK.length && oldK[pi].outerHTML === newK[pi].outerHTML) pi++;
                        if (pi === oldK.length && pi === newK.length) continue; // identical
                        // Common suffix
                        var oi = oldK.length - 1, ni = newK.length - 1;
                        while (oi >= pi && ni >= pi && oldK[oi].outerHTML === newK[ni].outerHTML) { oi--; ni--; }
                        // Remove old diff range
                        for (var j = oi; j >= pi; j--) oldK[j].remove();
                        // Insert new diff range
                        var before = (oi + 1 < oldK.length) ? oldK[oi + 1] : oldB.querySelector('.footnotes');
                        for (var j = pi; j <= ni; j++) oldB.insertBefore(newK[j].cloneNode(true), before);
                        if (newK.length > oldK.length) contentAdded = true;
                    }
                    // Set scroll target
                    if (contentAdded) {
                        window._pendingScrollTo = '_last_page';
                    } else if (msg.scrollTo) {
                        window._pendingScrollTo = msg.scrollTo;
                    } else if (visiblePageNum > 0) {
                        window._pendingScrollTo = '.page[data-page="' + visiblePageNum + '"]';
                        window._pendingScrollBehavior = 'instant';
                    }
                    // Re-paginate (will also re-scale and remove freeze)
                    if (typeof window._wordPaginate === 'function') window._wordPaginate();
                    else { var f=document.getElementById('_sse_freeze'); if(f)f.remove(); }
                });
            }
            // Track version for gap detection
            var _clientVersion = 0;
            // Apply server-side block patches directly to DOM
            function wordPatchUpdate(msg) {
                // De-paginate: merge pagination-created pages back into section wrappers
                var allW = Array.from(document.querySelectorAll('.page-wrapper'));
                var curSec = null;
                allW.forEach(function(w) {
                    if (w.hasAttribute('data-section')) { curSec = w; return; }
                    if (!curSec) return;
                    var src = w.querySelector('.page-body');
                    var dst = curSec.querySelector('.page-body');
                    if (src && dst) {
                        Array.from(src.children).forEach(function(c) {
                            if (!c.classList.contains('footnotes')) dst.appendChild(c);
                        });
                    }
                    w.remove();
                });
                var contentAdded = false;
                msg.patches.forEach(function(patch) {
                    if (patch.op === 'style') {
                        // Update CSS styles in head
                        document.querySelectorAll('head style').forEach(function(s) { s.remove(); });
                        var tmp = document.createElement('div');
                        tmp.innerHTML = patch.html;
                        tmp.querySelectorAll('style').forEach(function(s) { document.head.appendChild(s); });
                        return;
                    }
                    var bStart = document.querySelector('.wb[data-block="' + patch.block + '"]');
                    var bEnd = document.querySelector('.we[data-block="' + patch.block + '"]');
                    if (patch.op === 'remove') {
                        if (bStart && bEnd) {
                            // Remove everything between bStart and bEnd (inclusive)
                            var cur = bStart.nextSibling;
                            while (cur && cur !== bEnd) { var nx = cur.nextSibling; cur.remove(); cur = nx; }
                            bEnd.remove();
                            bStart.remove();
                        }
                    } else if (patch.op === 'replace') {
                        if (bStart && bEnd) {
                            // Remove old content between markers
                            var cur = bStart.nextSibling;
                            while (cur && cur !== bEnd) { var nx = cur.nextSibling; cur.remove(); cur = nx; }
                            // Insert new content before bEnd
                            var tmp = document.createElement('div');
                            tmp.innerHTML = patch.html;
                            while (tmp.firstChild) bEnd.parentNode.insertBefore(tmp.firstChild, bEnd);
                        }
                    } else if (patch.op === 'add') {
                        contentAdded = true;
                        var tmp = document.createElement('div');
                        tmp.innerHTML = '<span class="wb" data-block="' + patch.block + '" style="display:none"></span>' +
                            patch.html +
                            '<span class="we" data-block="' + patch.block + '" style="display:none"></span>';
                        // Find insertion point: after previous block's end, or before next block's begin
                        var prevEnd = patch.block > 1 ? document.querySelector('.we[data-block="' + (patch.block - 1) + '"]') : null;
                        if (prevEnd) {
                            var ref = prevEnd.nextSibling;
                            while (tmp.firstChild) prevEnd.parentNode.insertBefore(tmp.firstChild, ref);
                        } else {
                            var nextBegin = document.querySelector('.wb[data-block="' + (patch.block + 1) + '"]');
                            if (nextBegin) {
                                // Also include the anchor before nextBegin if present
                                var ref = nextBegin.previousSibling && nextBegin.previousSibling.tagName === 'A' ? nextBegin.previousSibling : nextBegin;
                                while (tmp.firstChild) ref.parentNode.insertBefore(tmp.firstChild, ref);
                            } else {
                                // Last resort: append to the closest page-body
                                var body = document.querySelector('.page-body');
                                while (tmp.firstChild) body.appendChild(tmp.firstChild);
                            }
                        }
                    }
                });
                // Set scroll target
                if (contentAdded) {
                    window._pendingScrollTo = '_last_page';
                    window._pendingScrollBehavior = 'instant';
                } else if (msg.scrollTo) {
                    window._pendingScrollTo = msg.scrollTo;
                }
                _clientVersion = msg.version;
                // Re-paginate + render new KaTeX/CJK
                if (typeof window._wordPaginate === 'function') window._wordPaginate();
            }
            es.addEventListener('update', function(e) {
                var msg = JSON.parse(e.data);
                // Track version
                if (msg.version !== undefined) _clientVersion = msg.version;
                if (msg.action === 'word-patch') {
                    // Version gap check: if we missed messages, fallback to full
                    if (msg.baseVersion !== 0 && msg.baseVersion !== _clientVersion) {
                        wordDiffUpdate(msg);
                        if (msg.version !== undefined) _clientVersion = msg.version;
                        return;
                    }
                    wordPatchUpdate(msg);
                    return;
                }
                if (msg.action === 'full') {
                    // Word: fallback diff-based update
                    if (document.querySelector('.page-wrapper[data-section]')) {
                        wordDiffUpdate(msg);
                        return;
                    }
                    // Non-Word (PPT/Excel): full body replacement
                    fetch('/').then(function(r) { return r.text(); }).then(function(html) {
                        var doc = new DOMParser().parseFromString(html, 'text/html');
                        var oldStyles = document.querySelectorAll('head style');
                        var newStyles = doc.querySelectorAll('head style');
                        oldStyles.forEach(function(s) { s.remove(); });
                        newStyles.forEach(function(s) { document.head.appendChild(s.cloneNode(true)); });
                        var scripts = document.body.querySelectorAll('script');
                        var sseScript = null;
                        scripts.forEach(function(s) { if (s.textContent.indexOf('EventSource') >= 0) sseScript = s; });
                        var targetSheetIdx = -1;
                        if (msg.scrollTo && msg.scrollTo.indexOf('data-sheet') >= 0) {
                            var m = msg.scrollTo.match(/data-sheet="(\d+)"/);
                            if (m) targetSheetIdx = parseInt(m[1]);
                        }
                        if (targetSheetIdx >= 0) {
                            doc.querySelectorAll('.sheet-content').forEach(function(s) {
                                var idx = parseInt(s.getAttribute('data-sheet'));
                                if (idx === targetSheetIdx) s.classList.add('active');
                                else s.classList.remove('active');
                            });
                            doc.querySelectorAll('.sheet-tab').forEach(function(t) {
                                var idx = parseInt(t.getAttribute('data-sheet'));
                                if (idx === targetSheetIdx) t.classList.add('active');
                                else t.classList.remove('active');
                            });
                        }
                        var savedScrollY = window.scrollY;
                        document.body.innerHTML = doc.body.innerHTML;
                        if (sseScript) document.body.appendChild(sseScript);
                        window.scrollTo(0, savedScrollY);
                        doc.body.querySelectorAll('script').forEach(function(s) {
                            if (s.textContent.indexOf('EventSource') >= 0) return;
                            var ns = document.createElement('script');
                            ns.textContent = s.textContent;
                            document.body.appendChild(ns);
                        });
                        if (msg.scrollTo && targetSheetIdx < 0) {
                            window._pendingScrollTo = msg.scrollTo;
                        }
                    });
                    return;
                }
                var slideNum = msg.slide;
                if (msg.action === 'replace') {
                    var el = document.querySelector('.slide-container[data-slide="' + slideNum + '"]');
                    if (el) {
                        var tmp = document.createElement('div');
                        tmp.innerHTML = msg.html;
                        var newEl = tmp.firstElementChild;
                        el.parentNode.replaceChild(newEl, el);
                        if (typeof scaleSlides === 'function') scaleSlides();
                        syncThumbs();
                        scrollToSlide(slideNum);
                    } else {
                        location.reload();
                    }
                } else if (msg.action === 'remove') {
                    var el = document.querySelector('.slide-container[data-slide="' + slideNum + '"]');
                    if (el) el.remove();
                    // renumber remaining slides
                    document.querySelectorAll('.slide-container').forEach(function(c, i) {
                        c.setAttribute('data-slide', i + 1);
                    });
                    syncThumbs();
                } else if (msg.action === 'add') {
                    var main = document.querySelector('.main');
                    if (main) {
                        var tmp = document.createElement('div');
                        tmp.innerHTML = msg.html;
                        var newEl = tmp.firstElementChild;
                        main.appendChild(newEl);
                        if (typeof scaleSlides === 'function') scaleSlides();
                    }
                    syncThumbs();
                    scrollToSlide(slideNum);
                }
            });
        })();
        </script>
        """;

    public WatchServer(string filePath, int port, TimeSpan? idleTimeout = null, string? initialHtml = null)
    {
        _filePath = Path.GetFullPath(filePath);
        _pipeName = GetWatchPipeName(_filePath);
        _port = port;
        _idleTimeout = idleTimeout ?? TimeSpan.FromMinutes(5);
        _tcpListener = new TcpListener(IPAddress.Loopback, _port);
        if (!string.IsNullOrEmpty(initialHtml))
            _currentHtml = initialHtml;
    }

    public static string GetWatchPipeName(string filePath)
    {
        var fullPath = Path.GetFullPath(filePath);
        if (OperatingSystem.IsWindows() || OperatingSystem.IsMacOS())
            fullPath = fullPath.ToUpperInvariant();
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(fullPath)))[..16];
        return $"officecli-watch-{hash}";
    }

    /// <summary>
    /// Check if another watch process is already running for this file.
    /// Returns the port number if running, or null if not.
    /// </summary>
    public static int? GetExistingWatchPort(string filePath)
    {
        try
        {
            int? result = null;
            var task = Task.Run(() =>
            {
                var pipeName = GetWatchPipeName(filePath);
                using var client = new System.IO.Pipes.NamedPipeClientStream(".", pipeName, System.IO.Pipes.PipeDirection.InOut);
                client.Connect(100);
                var noBom = new UTF8Encoding(false);
                using var writer = new StreamWriter(client, noBom, leaveOpen: true) { AutoFlush = true };
                writer.WriteLine("ping");
                writer.Flush();
                using var reader = new StreamReader(client, noBom, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                var response = reader.ReadLine();
                result = int.TryParse(response, out var port) ? port : 0;
            });
            return task.Wait(TimeSpan.FromSeconds(2)) ? result : null;
        }
        catch
        {
            return null; // not running
        }
    }

    public async Task RunAsync(CancellationToken externalToken = default)
    {
        // Prevent duplicate watch processes for the same file
        var existingPort = GetExistingWatchPort(_filePath);
        if (existingPort.HasValue)
        {
            var url = existingPort.Value > 0 ? $" at http://localhost:{existingPort.Value}" : "";
            throw new InvalidOperationException($"Another watch process is already running{url} for {_filePath}");
        }

        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, externalToken);
        var token = linkedCts.Token;

        _tcpListener.Start();
        Console.WriteLine($"Watch: http://localhost:{_port}");
        Console.WriteLine($"Watching: {_filePath}");
        Console.WriteLine("Press Ctrl+C to stop.");

        var pipeTask = RunPipeListenerAsync(token);
        var idleTask = RunIdleWatchdogAsync(token);

        while (!token.IsCancellationRequested)
        {
            try
            {
                var client = await _tcpListener.AcceptTcpClientAsync(token);
                _ = HandleClientAsync(client, token);
            }
            catch (OperationCanceledException) { break; }
            catch (SocketException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Watch HTTP error: {ex.Message}");
            }
        }

        // Pipe listener may not cancel promptly on Windows (WaitForConnectionAsync
        // ignores CancellationToken on some OS versions). Connect-and-drop to unblock it.
        try
        {
            using var kickPipe = new System.IO.Pipes.NamedPipeClientStream(".", _pipeName, System.IO.Pipes.PipeDirection.InOut);
            kickPipe.Connect(500);
        }
        catch { }

        try { await pipeTask; } catch (OperationCanceledException) { }
        try { await idleTask; } catch (OperationCanceledException) { }
    }

    private async Task RunIdleWatchdogAsync(CancellationToken token)
    {
        var checkInterval = TimeSpan.FromSeconds(Math.Min(30, Math.Max(1, _idleTimeout.TotalSeconds / 2)));
        while (!token.IsCancellationRequested)
        {
            await Task.Delay(checkInterval, token);
            int clientCount;
            lock (_sseLock) { clientCount = _sseClients.Count; }
            if (clientCount == 0 && DateTime.UtcNow - _lastActivityTime > _idleTimeout)
            {
                Console.WriteLine("Watch: idle timeout, shutting down.");
                _cts.Cancel();
                break;
            }
        }
    }

    private async Task RunPipeListenerAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var server = new System.IO.Pipes.NamedPipeServerStream(
                _pipeName, System.IO.Pipes.PipeDirection.InOut,
                System.IO.Pipes.NamedPipeServerStream.MaxAllowedServerInstances,
                System.IO.Pipes.PipeTransmissionMode.Byte,
                System.IO.Pipes.PipeOptions.Asynchronous);
            try
            {
                await server.WaitForConnectionAsync(token);
                var noBom = new UTF8Encoding(false);
                using var reader = new StreamReader(server, noBom, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                using var writer = new StreamWriter(server, noBom, leaveOpen: true) { AutoFlush = true };

                var message = await reader.ReadLineAsync(token);
                _lastActivityTime = DateTime.UtcNow;

                if (message == "close")
                {
                    await writer.WriteLineAsync("ok".AsMemory(), token);
                    Console.WriteLine("Watch closed by remote command.");
                    try { _tcpListener.Stop(); } catch { }
                    _cts.Cancel();
                    break;
                }
                else if (message == "ping")
                {
                    // Return port so callers can find the existing watch URL
                    await writer.WriteLineAsync(_port.ToString().AsMemory(), token);
                }
                else if (message != null)
                {
                    await writer.WriteLineAsync("ok".AsMemory(), token);
                    // Try to parse as WatchMessage JSON
                    HandleWatchMessage(message);
                }
            }
            catch (OperationCanceledException) { break; }
            catch { /* ignore pipe errors */ }
            finally
            {
                await server.DisposeAsync();
            }
        }
    }

    private void HandleWatchMessage(string json)
    {
        try
        {
            var msg = JsonSerializer.Deserialize(json, WatchMessageJsonContext.Default.WatchMessage);
            if (msg == null) return;

            var oldHtml = _currentHtml;
            var baseVersion = _version;

            // Always update cached full HTML when provided (authoritative snapshot)
            if (!string.IsNullOrEmpty(msg.FullHtml))
            {
                _currentHtml = msg.FullHtml;
            }

            // Apply incremental patch when no full HTML was provided
            if (string.IsNullOrEmpty(msg.FullHtml))
            {
                if (msg.Action == "replace" && msg.Slide > 0 && msg.Html != null)
                    _currentHtml = PatchSlideInHtml(_currentHtml, msg.Slide, msg.Html);
                else if (msg.Action == "add" && msg.Html != null)
                    _currentHtml = AppendSlideToHtml(_currentHtml, msg.Html);
                else if (msg.Action == "remove" && msg.Slide > 0)
                    _currentHtml = RemoveSlideFromHtml(_currentHtml, msg.Slide);
            }

            _version++;

            // Word: try block-level diff instead of full refresh
            if (msg.Action == "full" && !string.IsNullOrEmpty(msg.FullHtml)
                && !string.IsNullOrEmpty(oldHtml) && oldHtml.Contains("data-block=\"1\""))
            {
                var patches = ComputeWordPatches(oldHtml, msg.FullHtml);
                // Check if CSS styles changed
                var oldStyle = ExtractStyleBlock(oldHtml);
                var newStyle = ExtractStyleBlock(msg.FullHtml);
                var styleChanged = oldStyle != newStyle;

                if (patches != null || styleChanged)
                {
                    patches ??= new List<WordPatch>();
                    if (styleChanged)
                        patches.Insert(0, new WordPatch { Op = "style", Block = 0, Html = newStyle });
                    SendSseWordPatch(patches, _version, baseVersion, msg.ScrollTo);
                    return;
                }
            }

            // Forward to SSE clients (full or PPT incremental)
            SendSseEvent(msg.Action, msg.Slide, msg.Html, msg.ScrollTo, _version);
        }
        catch
        {
            // Legacy format or parse error — treat as full refresh signal
            _version++;
            SendSseEvent("full", 0, null, null, _version);
        }
    }

    /// <summary>Replace a single slide fragment in the full HTML by data-slide number.</summary>
    private static string PatchSlideInHtml(string html, int slideNum, string newFragment)
    {
        var (start, end) = FindSlideFragmentRange(html, slideNum);
        if (start < 0) return html;
        return string.Concat(html.AsSpan(0, start), newFragment, html.AsSpan(end));
    }

    /// <summary>Append a slide fragment before the last closing tag of the main container.</summary>
    private static string AppendSlideToHtml(string html, string fragment)
    {
        // Find the last </div> before </body> — that's the .main container's closing tag
        var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (bodyClose < 0) return html + fragment;
        // Find the </div> just before </body>
        var mainClose = html.LastIndexOf("</div>", bodyClose, StringComparison.OrdinalIgnoreCase);
        if (mainClose < 0) return html;
        return string.Concat(html.AsSpan(0, mainClose), fragment, "\n", html.AsSpan(mainClose));
    }

    /// <summary>Remove a slide fragment from the full HTML.</summary>
    private static string RemoveSlideFromHtml(string html, int slideNum)
    {
        var (start, end) = FindSlideFragmentRange(html, slideNum);
        if (start < 0) return html;
        return string.Concat(html.AsSpan(0, start), html.AsSpan(end));
    }

    /// <summary>Find the start/end character positions of a slide-container div in the HTML.</summary>
    private static (int Start, int End) FindSlideFragmentRange(string html, int slideNum)
    {
        var marker = $"data-slide=\"{slideNum}\"";
        var idx = html.IndexOf(marker, StringComparison.Ordinal);
        if (idx < 0) return (-1, -1);

        var start = html.LastIndexOf("<div ", idx, StringComparison.Ordinal);
        if (start < 0) return (-1, -1);

        // Find matching closing </div> by counting nesting
        var depth = 0;
        var pos = start;
        while (pos < html.Length)
        {
            var nextOpen = html.IndexOf("<div", pos, StringComparison.OrdinalIgnoreCase);
            var nextClose = html.IndexOf("</div>", pos, StringComparison.OrdinalIgnoreCase);

            if (nextClose < 0) break;

            if (nextOpen >= 0 && nextOpen < nextClose)
            {
                depth++;
                pos = nextOpen + 4;
            }
            else
            {
                depth--;
                if (depth == 0)
                    return (start, nextClose + 6);
                pos = nextClose + 6;
            }
        }

        return (-1, -1);
    }

    /// <summary>Extract all &lt;style&gt; blocks from HTML head, concatenated.</summary>
    private static string? ExtractStyleBlock(string html)
    {
        var sb = new StringBuilder();
        var idx = 0;
        while (true)
        {
            var start = html.IndexOf("<style>", idx, StringComparison.OrdinalIgnoreCase);
            if (start < 0) start = html.IndexOf("<style ", idx, StringComparison.OrdinalIgnoreCase);
            if (start < 0) break;
            var end = html.IndexOf("</style>", start, StringComparison.OrdinalIgnoreCase);
            if (end < 0) break;
            end += 8; // include </style>
            sb.Append(html, start, end - start);
            idx = end;
        }
        return sb.Length > 0 ? sb.ToString() : null;
    }

    /// <summary>Split Word HTML into blocks keyed by block number. Returns dict of blockNum → content.</summary>
    private static Dictionary<int, string> SplitWordBlocks(string html)
    {
        var blocks = new Dictionary<int, string>();
        var beginRx = new System.Text.RegularExpressions.Regex(@"<span class=""wb"" data-block=""(\d+)"" style=""display:none""></span>");
        var matches = beginRx.Matches(html);
        for (int i = 0; i < matches.Count; i++)
        {
            var m = matches[i];
            var blockNum = int.Parse(m.Groups[1].Value);
            var contentStart = m.Index + m.Length;
            var endMarker = $"<span class=\"we\" data-block=\"{blockNum}\" style=\"display:none\"></span>";
            var endIdx = html.IndexOf(endMarker, contentStart, StringComparison.Ordinal);
            if (endIdx >= 0)
                blocks[blockNum] = html[contentStart..endIdx];
        }
        return blocks;
    }

    /// <summary>Compute block-level patches between old and new Word HTML. Returns null if diff is too large (fallback to full).</summary>
    internal static List<WordPatch>? ComputeWordPatches(string oldHtml, string newHtml)
    {
        // Only diff if both are Word documents with block markers
        if (string.IsNullOrEmpty(oldHtml) || string.IsNullOrEmpty(newHtml))
            return null;
        if (!oldHtml.Contains("data-block=\"1\"") || !newHtml.Contains("data-block=\"1\""))
            return null;

        var oldBlocks = SplitWordBlocks(oldHtml);
        var newBlocks = SplitWordBlocks(newHtml);

        if (oldBlocks.Count == 0 && newBlocks.Count == 0) return null;

        var patches = new List<WordPatch>();

        // Find max block number across both
        var maxBlock = 0;
        foreach (var k in oldBlocks.Keys) if (k > maxBlock) maxBlock = k;
        foreach (var k in newBlocks.Keys) if (k > maxBlock) maxBlock = k;

        for (int b = 1; b <= maxBlock; b++)
        {
            var inOld = oldBlocks.TryGetValue(b, out var oldContent);
            var inNew = newBlocks.TryGetValue(b, out var newContent);

            if (inOld && inNew)
            {
                if (oldContent != newContent)
                    patches.Add(new WordPatch { Op = "replace", Block = b, Html = newContent });
                // else: unchanged, skip
            }
            else if (!inOld && inNew)
            {
                patches.Add(new WordPatch { Op = "add", Block = b, Html = newContent });
            }
            else if (inOld && !inNew)
            {
                patches.Add(new WordPatch { Op = "remove", Block = b });
            }
        }

        if (patches.Count == 0) return null; // no changes

        // If more than 60% of blocks changed (and enough blocks to matter), fallback to full refresh
        var totalBlocks = Math.Max(oldBlocks.Count, newBlocks.Count);
        if (totalBlocks >= 5 && patches.Count > totalBlocks * 0.6)
            return null;

        return patches;
    }

    private void SendSseWordPatch(List<WordPatch> patches, int version, int baseVersion, string? scrollTo)
    {
        var sb = new StringBuilder();
        sb.Append("{\"action\":\"word-patch\"");
        sb.Append(",\"version\":").Append(version);
        sb.Append(",\"baseVersion\":").Append(baseVersion);
        sb.Append(",\"patches\":[");
        for (int i = 0; i < patches.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"op\":\"").Append(patches[i].Op).Append('"');
            sb.Append(",\"block\":").Append(patches[i].Block);
            if (patches[i].Html != null)
            {
                sb.Append(",\"html\":");
                AppendJsonString(sb, patches[i].Html!);
            }
            sb.Append('}');
        }
        sb.Append(']');
        if (scrollTo != null)
        {
            sb.Append(",\"scrollTo\":");
            AppendJsonString(sb, scrollTo);
        }
        sb.Append('}');
        BroadcastSse(sb.ToString());
    }

    private void SendSseEvent(string action, int slideNum, string? html, string? scrollTo = null, int version = 0)
    {
        // Build JSON manually to avoid dependency
        var sb = new StringBuilder();
        sb.Append("{\"action\":\"").Append(action).Append('"');
        sb.Append(",\"slide\":").Append(slideNum);
        sb.Append(",\"version\":").Append(version);
        if (html != null)
        {
            sb.Append(",\"html\":");
            AppendJsonString(sb, html);
        }
        if (scrollTo != null)
        {
            sb.Append(",\"scrollTo\":");
            AppendJsonString(sb, scrollTo);
        }
        sb.Append('}');

        BroadcastSse(sb.ToString());
    }

    private void BroadcastSse(string sseJson)
    {
        lock (_sseLock)
        {
            var dead = new List<NetworkStream>();
            foreach (var client in _sseClients)
            {
                try
                {
                    var data = Encoding.UTF8.GetBytes($"event: update\ndata: {sseJson}\n\n");
                    client.Write(data);
                    client.Flush();
                }
                catch
                {
                    dead.Add(client);
                }
            }
            foreach (var d in dead) _sseClients.Remove(d);
        }
    }

    private static void AppendJsonString(StringBuilder sb, string value)
    {
        sb.Append('"');
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20)
                        sb.Append($"\\u{(int)ch:X4}");
                    else
                        sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken token)
    {
        try
        {
            var stream = client.GetStream();
            var requestLine = await ReadHttpRequestAsync(stream, token);

            if (requestLine.Contains("GET /events"))
            {
                try
                {
                    await HandleSseAsync(stream, token);
                }
                finally
                {
                    client.Close();
                }
            }
            else
            {
                var html = string.IsNullOrEmpty(_currentHtml)
                    ? InjectSseScript(WaitingHtml)
                    : InjectSseScript(_currentHtml);
                var body = Encoding.UTF8.GetBytes(html);
                var header = Encoding.UTF8.GetBytes(
                    $"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(header, token);
                await stream.WriteAsync(body, token);
                client.Close();
            }
        }
        catch
        {
            try { client.Close(); } catch { }
        }
    }

    private static async Task<string> ReadHttpRequestAsync(NetworkStream stream, CancellationToken token)
    {
        var buffer = new byte[4096];
        var read = await stream.ReadAsync(buffer, token);
        var request = Encoding.UTF8.GetString(buffer, 0, read);
        var idx = request.IndexOf('\r');
        return idx >= 0 ? request[..idx] : request;
    }

    private async Task HandleSseAsync(NetworkStream stream, CancellationToken token)
    {
        var header = Encoding.UTF8.GetBytes(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n");
        await stream.WriteAsync(header, token);

        _lastActivityTime = DateTime.UtcNow;
        lock (_sseLock) { _sseClients.Add(stream); }

        try
        {
            while (!token.IsCancellationRequested)
            {
                await Task.Delay(30000, token);
                var heartbeat = Encoding.UTF8.GetBytes(": heartbeat\n\n");
                await stream.WriteAsync(heartbeat, token);
            }
        }
        catch { }
        finally
        {
            lock (_sseLock) { _sseClients.Remove(stream); }
        }
    }

    private static string InjectSseScript(string html)
    {
        var idx = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
            return html[..idx] + SseScript + html[idx..];
        return html + SseScript;
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            _disposed = true;
            _cts.Cancel();
            try { _tcpListener.Stop(); } catch { }

            // Kick the pipe listener out of WaitForConnectionAsync — it may not
            // honour CancellationToken on some Windows versions.
            try
            {
                using var kick = new System.IO.Pipes.NamedPipeClientStream(".", _pipeName, System.IO.Pipes.PipeDirection.InOut);
                kick.Connect(500);
            }
            catch { }

            _cts.Dispose();
        }
    }
}
