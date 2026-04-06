// Copyright 2025 OfficeCli (officecli.ai)
// SPDX-License-Identifier: Apache-2.0

namespace OfficeCli.Core;

public enum IssueType
{
    Format,
    Content,
    Structure
}

public enum IssueSeverity
{
    Error,
    Warning,
    Info
}

public class DocumentIssue
{
    public string Id { get; set; } = "";
    public IssueType Type { get; set; }
    public IssueSeverity Severity { get; set; }
    public string Path { get; set; } = "";
    public string Message { get; set; } = "";
    public string? Context { get; set; }
    public string? Suggestion { get; set; }
}
