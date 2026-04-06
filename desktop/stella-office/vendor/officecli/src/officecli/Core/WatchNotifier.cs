// Copyright 2025 OfficeCli (officecli.ai)
// SPDX-License-Identifier: Apache-2.0

using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace OfficeCli.Core;

/// <summary>
/// Sends refresh notifications (with rendered HTML) to a running watch process.
/// Non-blocking, fire-and-forget. Silently does nothing if no watch is running.
/// All pipe I/O is bounded by a timeout to prevent hangs.
/// </summary>
public static class WatchNotifier
{
    private static readonly TimeSpan PipeTimeout = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Notify watch with a pre-built message.
    /// The watch server never opens the file — all rendering is done by the caller.
    /// </summary>
    public static void NotifyIfWatching(string filePath, WatchMessage message)
    {
        try
        {
            RunWithTimeout(() =>
            {
                var pipeName = WatchServer.GetWatchPipeName(filePath);
                using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
                client.Connect(100); // fast fail if no watch

                var json = JsonSerializer.Serialize(message, WatchMessageJsonContext.Default.WatchMessage);

                // Write first, then read. Creating StreamReader before writing
                // causes a deadlock: StreamReader's constructor probes for BOM by
                // reading from the pipe, but the server is waiting for our write.
                using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
                writer.WriteLine(json);

                using var reader = new StreamReader(client, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                reader.ReadLine(); // wait for ack
            }, PipeTimeout);
        }
        catch
        {
            // No watch process running, or timed out — silently ignore
        }
    }

    /// <summary>
    /// Send a close command to a running watch process.
    /// Returns true if the watch was successfully closed.
    /// </summary>
    public static bool SendClose(string filePath)
    {
        try
        {
            bool result = false;
            RunWithTimeout(() =>
            {
                var pipeName = WatchServer.GetWatchPipeName(filePath);
                using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
                client.Connect(200);

                // Write first, then read — same ordering as NotifyIfWatching
                // to avoid BOM-detection deadlock on the pipe.
                using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
                writer.WriteLine("close");
                writer.Flush();

                using var reader = new StreamReader(client, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                reader.ReadLine();
                result = true;
            }, PipeTimeout);
            return result;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Run an action on a background thread with a timeout.
    /// Prevents the calling thread from hanging if the pipe server dies mid-conversation.
    /// </summary>
    private static void RunWithTimeout(Action action, TimeSpan timeout)
    {
        var task = Task.Run(action);
        if (!task.Wait(timeout))
            throw new TimeoutException("Pipe communication timed out");
        task.GetAwaiter().GetResult(); // propagate exceptions
    }
}

/// <summary>
/// Message sent from command processes to the watch server via named pipe.
/// </summary>
public class WatchMessage
{
    /// <summary>"replace", "add", "remove", or "full"</summary>
    public string Action { get; set; } = "full";

    /// <summary>Slide number (0 for full refresh)</summary>
    public int Slide { get; set; }

    /// <summary>Single slide HTML fragment (for replace/add)</summary>
    public string? Html { get; set; }

    /// <summary>Full HTML of the entire presentation (for caching by watch server)</summary>
    public string? FullHtml { get; set; }

    /// <summary>CSS selector for the element to scroll to after full refresh (Word/Excel)</summary>
    public string? ScrollTo { get; set; }

    /// <summary>Incremental version number for ordering and gap detection.</summary>
    public int Version { get; set; }

    /// <summary>Version the client must have before applying these patches.</summary>
    public int BaseVersion { get; set; }

    /// <summary>Word block-level patches (for action="word-patch").</summary>
    public List<WordPatch>? Patches { get; set; }

    public static int ExtractSlideNum(string? path)
    {
        if (string.IsNullOrEmpty(path)) return 0;
        var match = System.Text.RegularExpressions.Regex.Match(path, @"/slide\[(\d+)\]");
        if (match.Success && int.TryParse(match.Groups[1].Value, out var num))
            return num;
        return 0;
    }

    /// <summary>Extract a CSS selector scroll target from a Word document path like /p[5] or /table[2].</summary>
    public static string? ExtractWordScrollTarget(string? path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var match = System.Text.RegularExpressions.Regex.Match(path, @"/(p|paragraph|table)\[(\d+)\]");
        if (!match.Success) return null;
        var type = match.Groups[1].Value;
        if (type == "paragraph") type = "p";
        return $"#w-{type}-{match.Groups[2].Value}";
    }

    /// <summary>Extract sheet name from an Excel document path like /Sheet1/A1 or Sheet1!A1.</summary>
    public static string? ExtractSheetName(string? path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        // Match /SheetName/... or SheetName!...
        var match = System.Text.RegularExpressions.Regex.Match(path, @"^/?([^/!]+)[/!]");
        return match.Success ? match.Groups[1].Value : null;
    }
}

/// <summary>A single block-level change for Word incremental updates.</summary>
public class WordPatch
{
    /// <summary>"replace", "add", or "remove"</summary>
    public string Op { get; set; } = "";

    /// <summary>Block number (matches <!--wB:N--> marker)</summary>
    public int Block { get; set; }

    /// <summary>New HTML content (null for remove)</summary>
    public string? Html { get; set; }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(WatchMessage))]
[System.Text.Json.Serialization.JsonSerializable(typeof(WordPatch))]
internal partial class WatchMessageJsonContext : System.Text.Json.Serialization.JsonSerializerContext { }
