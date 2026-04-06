// Copyright 2025 OfficeCli (officecli.ai)
// SPDX-License-Identifier: Apache-2.0

using System.CommandLine;
using OfficeCli.Core;

namespace OfficeCli;

static partial class CommandBuilder
{
    private static Command BuildSetCommand(Option<bool> jsonOption)
    {
        var forceOption = new Option<bool>("--force") { Description = "Force write even if document is protected" };
        var setFileArg = new Argument<FileInfo>("file") { Description = "Office document path (required even with open/close mode)" };
        var setPathArg = new Argument<string>("path") { Description = "DOM path to the element" };
        var propsOpt = new Option<string[]>("--prop") { Description = "Property to set (key=value)", AllowMultipleArgumentsPerToken = true };

        var setCommand = new Command("set", "Modify a document node's properties") { TreatUnmatchedTokensAsErrors = false };
        setCommand.Add(setFileArg);
        setCommand.Add(setPathArg);
        setCommand.Add(propsOpt);
        setCommand.Add(jsonOption);
        setCommand.Add(forceOption);

        setCommand.SetAction(result => { var json = result.GetValue(jsonOption); return SafeRun(() =>
        {
            var file = result.GetValue(setFileArg)!;
            var path = result.GetValue(setPathArg)!;
            var props = result.GetValue(propsOpt);
            var force = result.GetValue(forceOption);

            // Check document protection for .docx files
            // Skip protection check if the user is changing the protection mode itself
            var isProtectionChange = props?.Any(p => p.StartsWith("protection=", StringComparison.OrdinalIgnoreCase)) == true;
            if (!force && !isProtectionChange && file.Extension.Equals(".docx", StringComparison.OrdinalIgnoreCase))
            {
                var protectionError = CheckDocxProtection(file.FullName, path, json);
                if (protectionError != 0) return protectionError;
            }

            // Detect bare key=value positional arguments (missing --prop)
            var unmatchedKvWarnings = DetectUnmatchedKeyValues(result);
            if (unmatchedKvWarnings.Count > 0)
            {
                if (json)
                {
                    var kvWarnings = unmatchedKvWarnings.Select(kv => new OfficeCli.Core.CliWarning
                    {
                        Message = $"Bare property '{kv}' ignored. Use --prop {kv}",
                        Code = "missing_prop_flag",
                        Suggestion = $"--prop {kv}"
                    }).ToList();
                    Console.WriteLine(OutputFormatter.WrapEnvelopeError(
                        $"Properties specified without --prop flag. Use: officecli set <file> <path> --prop {string.Join(" --prop ", unmatchedKvWarnings)}",
                        kvWarnings));
                }
                else
                {
                    foreach (var kv in unmatchedKvWarnings)
                        Console.Error.WriteLine($"WARNING: Bare property '{kv}' ignored. Did you mean: --prop {kv}");
                    Console.Error.WriteLine("Hint: Properties must be passed with --prop flag, e.g. officecli set <file> <path> --prop key=value");
                }
                if (props == null || props.Length == 0)
                    return 2;
            }

            if (TryResident(file.FullName, req =>
            {
                req.Command = "set";
                req.Args["path"] = path;
                req.Props = ParsePropsArray(props);
            }, json) is {} rc) return rc;

            var properties = new Dictionary<string, string>();
            foreach (var prop in props ?? Array.Empty<string>())
            {
                var eqIdx = prop.IndexOf('=');
                if (eqIdx > 0)
                {
                    properties[prop[..eqIdx]] = prop[(eqIdx + 1)..];
                }
            }

            using var handler = DocumentHandlerFactory.Open(file.FullName, editable: true);
            var unsupported = handler.Set(path, properties);

            // Auto-correct: attempt to fix unsupported properties with Levenshtein distance == 1
            var autoCorrected = new List<(string Original, string Corrected, string Value)>();
            var stillUnsupported = new List<string>();
            foreach (var u in unsupported)
            {
                var rawKey = u.Contains(' ') ? u[..u.IndexOf(' ')] : u;
                if (properties.TryGetValue(rawKey, out var val))
                {
                    var (suggestion, dist, isUnique) = SuggestPropertyWithDistance(rawKey);
                    if (suggestion != null && dist == 1 && isUnique)
                    {
                        // Auto-correct: re-apply with corrected key
                        var correctedProps = new Dictionary<string, string> { [suggestion] = val };
                        var retryUnsupported = handler.Set(path, correctedProps);
                        if (retryUnsupported.Count == 0)
                        {
                            autoCorrected.Add((rawKey, suggestion, val));
                            continue;
                        }
                    }
                }
                stillUnsupported.Add(u);
            }

            // unsupported entries may contain help text like "key (valid props: ...)" — extract raw keys
            var unsupportedKeys = stillUnsupported.Select(u => u.Contains(' ') ? u[..u.IndexOf(' ')] : u).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var autoCorrectedKeys = autoCorrected.Select(ac => ac.Original).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var applied = properties.Where(kv => !unsupportedKeys.Contains(kv.Key) && !autoCorrectedKeys.Contains(kv.Key)).ToList();
            // Include auto-corrected props in applied list with the corrected key name
            foreach (var ac in autoCorrected)
                applied.Add(new KeyValuePair<string, string>(ac.Corrected, ac.Value));

            // Get find match count if applicable
            int? findMatchCount = null;
            if (properties.ContainsKey("find"))
            {
                findMatchCount = handler switch
                {
                    OfficeCli.Handlers.WordHandler wh => wh.LastFindMatchCount,
                    OfficeCli.Handlers.PowerPointHandler ph => ph.LastFindMatchCount,
                    OfficeCli.Handlers.ExcelHandler eh => eh.LastFindMatchCount,
                    _ => null
                };
            }

            var message = applied.Count > 0
                ? $"Updated {path}: {string.Join(", ", applied.Select(kv => $"{kv.Key}={kv.Value}"))}"
                  + (findMatchCount.HasValue ? $" ({findMatchCount.Value} matched)" : "")
                : $"No properties applied to {path}";

            // Check if position-related props were changed → show coordinates + overlap warning
            var positionChanged = applied.Any(kv => PositionKeys.Contains(kv.Key));
            string? setSpatialLine = null;
            var setOverlaps = new List<string>();
            if (positionChanged)
            {
                setSpatialLine = GetPptSpatialLine(handler, path);
                if (setSpatialLine != null) setOverlaps = CheckPositionOverlap(handler, path);
            }

            if (json)
            {
                var allWarnings = new List<OfficeCli.Core.CliWarning>();
                foreach (var ac in autoCorrected)
                {
                    allWarnings.Add(new OfficeCli.Core.CliWarning
                    {
                        Message = $"Auto-corrected '{ac.Original}' to '{ac.Corrected}'",
                        Code = "auto_corrected",
                        Suggestion = ac.Corrected
                    });
                }
                foreach (var p in stillUnsupported)
                {
                    var suggestion = SuggestProperty(p);
                    allWarnings.Add(new OfficeCli.Core.CliWarning
                    {
                        Message = suggestion != null ? $"Unsupported property: {p} (did you mean: {suggestion}?)" : $"Unsupported property: {p}",
                        Code = "unsupported_property",
                        Suggestion = suggestion
                    });
                }
                if (setOverlaps.Count > 0)
                {
                    allWarnings.Add(new OfficeCli.Core.CliWarning
                    {
                        Message = $"Same position as {string.Join(", ", setOverlaps)}",
                        Code = "position_overlap",
                        Suggestion = "Use different x/y values to avoid overlap"
                    });
                }
                var setOverflow = CheckTextOverflow(handler, path);
                if (setOverflow != null)
                {
                    allWarnings.Add(new OfficeCli.Core.CliWarning
                    {
                        Message = setOverflow,
                        Code = "text_overflow",
                        Suggestion = "Increase shape height/width, reduce font size, or shorten text"
                    });
                }
                var outputMsg = setSpatialLine != null ? $"{message}\n  {setSpatialLine}" : message;
                bool allFailed = applied.Count == 0 && (stillUnsupported.Count > 0 || unsupported.Count > 0);
                Console.WriteLine(allFailed
                    ? OutputFormatter.WrapEnvelopeError(outputMsg, allWarnings.Count > 0 ? allWarnings : null)
                    : OutputFormatter.WrapEnvelopeText(outputMsg, allWarnings.Count > 0 ? allWarnings : null, findMatchCount));
            }
            else
            {
                foreach (var ac in autoCorrected)
                    Console.Error.WriteLine($"WARNING: Auto-corrected '{ac.Original}' to '{ac.Corrected}'");
                Console.WriteLine(message);
                if (setSpatialLine != null) Console.WriteLine($"  {setSpatialLine}");
                if (setOverlaps.Count > 0)
                    Console.Error.WriteLine($"  WARNING: Same position as {string.Join(", ", setOverlaps)}");
                var setOverflowPlain = CheckTextOverflow(handler, path);
                if (setOverflowPlain != null)
                    Console.Error.WriteLine($"  WARNING: {setOverflowPlain}");
                if (stillUnsupported.Count > 0)
                    Console.Error.WriteLine(FormatUnsupported(stillUnsupported));
            }
            NotifyWatch(handler, file.FullName, path);

            if (stillUnsupported.Count > 0) return 2;
            return 0;
        }, json); });

        return setCommand;
    }
}
