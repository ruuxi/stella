// Copyright 2025 OfficeCli (officecli.ai)
// SPDX-License-Identifier: Apache-2.0

using System.CommandLine;
using OfficeCli.Core;

namespace OfficeCli;

static partial class CommandBuilder
{
    private static Command BuildValidateCommand(Option<bool> jsonOption)
    {
        var validateFileArg = new Argument<FileInfo>("file") { Description = "Office document path (required even with open/close mode)" };
        var validateCommand = new Command("validate", "Validate document against OpenXML schema");
        validateCommand.Add(validateFileArg);
        validateCommand.Add(jsonOption);
        validateCommand.SetAction(result => { var json = result.GetValue(jsonOption); return SafeRun(() =>
        {
            var file = result.GetValue(validateFileArg)!;

            if (TryResident(file.FullName, req =>
            {
                req.Command = "validate";
                req.Json = json;
            }, json) is {} rc) return rc;

            using var handler = DocumentHandlerFactory.Open(file.FullName);
            var errors = handler.Validate();
            if (json)
            {
                var validationJson = FormatValidationErrors(errors);
                Console.WriteLine(OutputFormatter.WrapEnvelope(validationJson));
            }
            else
            {
                if (errors.Count == 0)
                {
                    Console.WriteLine("Validation passed: no errors found.");
                }
                else
                {
                    Console.WriteLine($"Found {errors.Count} validation error(s):");
                    foreach (var err in errors)
                    {
                        Console.WriteLine($"  [{err.ErrorType}] {err.Description}");
                        if (err.Path != null) Console.WriteLine($"    Path: {err.Path}");
                        if (err.Part != null) Console.WriteLine($"    Part: {err.Part}");
                    }
                }
            }
            return errors.Count > 0 ? 1 : 0;
        }, json); });

        return validateCommand;
    }

    private static Command BuildCheckCommand(Option<bool> jsonOption)
    {
        var checkFileArg = new Argument<FileInfo>("file") { Description = "Office document path (.pptx)" };
        var checkCommand = new Command("check", "Scan document for layout issues (text overflow, etc.)");
        checkCommand.Add(checkFileArg);
        checkCommand.Add(jsonOption);
        checkCommand.SetAction(result => { var json = result.GetValue(jsonOption); return SafeRun(() =>
        {
            var file = result.GetValue(checkFileArg)!;
            var ext = file.Extension.ToLowerInvariant();
            if (ext != ".pptx")
                throw new OfficeCli.Core.CliException("The 'check' command currently supports .pptx files only. Provide a .pptx file path.");

            using var handler = DocumentHandlerFactory.Open(file.FullName, editable: false);
            var pptHandler = handler as OfficeCli.Handlers.PowerPointHandler
                ?? throw new OfficeCli.Core.CliException("Failed to open file as PowerPoint document.");

            var issues = new List<(string Path, string Message)>();
            var root = pptHandler.Get("/");
            int slideCount = root?.Children?.Count ?? 0;
            for (int s = 1; s <= slideCount; s++)
            {
                var slideNode = pptHandler.Get($"/slide[{s}]");
                int shapeCount = slideNode?.Children?.Count ?? 0;
                for (int sh = 1; sh <= shapeCount; sh++)
                {
                    var shapePath = $"/slide[{s}]/shape[{sh}]";
                    var warning = pptHandler.CheckShapeTextOverflow(shapePath);
                    if (warning != null)
                        issues.Add((shapePath, warning));
                }
            }

            if (json)
            {
                var arr = new System.Text.Json.Nodes.JsonArray();
                foreach (var (path, msg) in issues)
                {
                    arr.Add((System.Text.Json.Nodes.JsonNode)new System.Text.Json.Nodes.JsonObject
                    {
                        ["path"] = path,
                        ["issue"] = msg
                    });
                }
                var envelope = new System.Text.Json.Nodes.JsonObject
                {
                    ["success"] = true,
                    ["file"] = file.FullName,
                    ["issueCount"] = issues.Count,
                    ["issues"] = arr
                };
                Console.WriteLine(envelope.ToJsonString(OutputFormatter.PublicJsonOptions));
            }
            else
            {
                Console.WriteLine($"Checking layout: {file.FullName}");
                if (issues.Count == 0)
                {
                    Console.WriteLine("No layout issues found.");
                }
                else
                {
                    foreach (var (path, msg) in issues)
                        Console.WriteLine($"  {path}: {msg}");
                    Console.WriteLine($"Found {issues.Count} layout issue(s).");
                }
            }
            return issues.Count > 0 ? 2 : 0;
        }, json); });

        return checkCommand;
    }
}
