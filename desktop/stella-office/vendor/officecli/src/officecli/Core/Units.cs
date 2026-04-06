// Copyright 2025 OfficeCli (officecli.ai)
// SPDX-License-Identifier: Apache-2.0

namespace OfficeCli.Core;

/// <summary>
/// Shared unit conversion utilities for HTML preview rendering.
/// All methods convert to points (pt) — the natural unit of the OOXML coordinate system.
///
/// Key relationships (all exact integer ratios):
///   1 pt = 20 twips        (Word)
///   1 pt = 12700 EMU       (PowerPoint / Excel drawings)
///   1 pt = 2 half-points   (font sizes)
///
/// Using pt avoids the precision loss inherent in converting to cm or px:
///   EMU → cm: 360000 EMU/cm produces irrational values for most inputs
///   twips → px: 1440 twips/inch × 96 DPI involves floating-point rounding
/// </summary>
internal static class Units
{
    /// <summary>Convert Word twips to points. 1 pt = 20 twips (exact).</summary>
    public static double TwipsToPt(int twips) => twips / 20.0;

    /// <summary>Convert Word twips (string) to points. Returns 0 for unparseable input.</summary>
    public static double TwipsToPt(string twipsStr)
    {
        if (!int.TryParse(twipsStr, out var twips)) return 0;
        return twips / 20.0;
    }

    /// <summary>Format Word twips (string) to CSS pt value, e.g. "36pt".</summary>
    public static string TwipsToPtStr(string twipsStr)
    {
        return $"{TwipsToPt(twipsStr):0.##}pt";
    }

    /// <summary>Convert EMU to points. 1 pt = 12700 EMU (exact).</summary>
    public static double EmuToPt(long emu) => Math.Round(emu / 12700.0, 2);

    /// <summary>Convert half-points to points. 1 pt = 2 half-points (exact).</summary>
    public static double HalfPointsToPt(int hp) => hp / 2.0;
}
