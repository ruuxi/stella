/**
 * Desktop Tab hero animation — shows the phone screen mirroring the desktop app.
 * Reverses the visual flow compared to ConnectHeroAnimation.
 */
import { useEffect, useId } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";
import { useColors } from "../theme/theme-context";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

const VB_W = 400;
const VB_H = 140;
// cardFill derived per-theme inside the component

export function DesktopTabAnimation() {
  const colors = useColors();
  const cardFill = colors.surface;
  const uid = useId().replace(/:/g, "");
  const gradId = `signal-grad-dt-${uid}`;
  const { width: windowWidth } = useWindowDimensions();
  const maxW = Math.min(windowWidth - 32, 440);
  const scale = maxW / VB_W;

  /* ── animation drivers ── */
  const signalOffset = useSharedValue(0);
  const cursorVal = useSharedValue(0);

  useEffect(() => {
    // Signal dashes flow: 1.5s linear (moving leftward, from Monitor to Phone)
    signalOffset.value = withRepeat(
      withTiming(-10, { duration: 1500, easing: Easing.linear }),
      -1,
      false,
    );
    // Cursor + ripple: 4s linear cycle
    cursorVal.value = withRepeat(
      withTiming(1, { duration: 4000, easing: Easing.linear }),
      -1,
      false,
    );
  }, []);

  /* ── animated props ── */

  // Signal line: flowing dashes
  const signalLineProps = useAnimatedProps(() => ({
    strokeDashoffset: signalOffset.value,
  }));

  // Monitor cursor: animate path d (all absolute coords)
  const monitorCursorProps = useAnimatedProps(() => {
    const p = cursorVal.value;
    const tx = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [15, 0, 0, 10, 10, 15],
    );
    const ty = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [20, 0, 0, -5, -5, 20],
    );
    return {
      d: `M${280 + tx} ${50 + ty} L${292 + tx} ${62 + ty} L${286 + tx} ${63 + ty} L${289 + tx} ${70 + ty} L${285 + tx} ${71 + ty} L${282 + tx} ${64 + ty} L${276 + tx} ${68 + ty} Z`,
    };
  });

  // Monitor click ripple
  const monitorRippleProps = useAnimatedProps(() => {
    const p = cursorVal.value;
    const tx = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [15, 0, 0, 10, 10, 15],
    );
    const ty = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [20, 0, 0, -5, -5, 20],
    );
    return {
      cx: 280 + tx,
      cy: 50 + ty,
      r: interpolate(p, [0, 0.2, 0.25, 0.35, 1], [2, 2, 10, 15, 15]),
      opacity: interpolate(p, [0, 0.2, 0.25, 0.35, 1], [0, 0, 0.3, 0, 0]),
    };
  });

  // Phone mirrored cursor (scaled to fit letterboxed display)
  const phoneCursorProps = useAnimatedProps(() => {
    const p = cursorVal.value;
    const tx = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [15, 0, 0, 10, 10, 15],
    );
    const ty = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [20, 0, 0, -5, -5, 20],
    );
    const tx2 = tx * 0.41;
    const ty2 = ty * 0.41;
    return {
      d: `M${99 + tx2} ${71 + ty2} L${104 + tx2} ${76 + ty2} L${101.5 + tx2} ${76.5 + ty2} L${102.5 + tx2} ${79 + ty2} L${101 + tx2} ${79.5 + ty2} L${100 + tx2} ${76.5 + ty2} L${97.5 + tx2} ${78.5 + ty2} Z`,
    };
  });

  // Phone mirrored ripple
  const phoneRippleProps = useAnimatedProps(() => {
    const p = cursorVal.value;
    const tx = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [15, 0, 0, 10, 10, 15],
    );
    const ty = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [20, 0, 0, -5, -5, 20],
    );
    const tx2 = tx * 0.41;
    const ty2 = ty * 0.41;
    return {
      cx: 99 + tx2,
      cy: 71 + ty2,
      r: interpolate(p, [0, 0.2, 0.25, 0.35, 1], [0.8, 0.8, 4, 6, 6]),
      opacity: interpolate(p, [0, 0.2, 0.25, 0.35, 1], [0, 0, 0.3, 0, 0]),
    };
  });

  return (
    <View
      style={{
        width: "100%",
        maxWidth: 440,
        height: VB_H * scale,
        alignSelf: "center",
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg
        width={VB_W * scale}
        height={VB_H * scale}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
      >
        <Defs>
          <LinearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <Stop offset="0%" stopColor={colors.accent} stopOpacity={0} />
            <Stop offset="20%" stopColor={colors.accent} stopOpacity={0.8} />
            <Stop offset="80%" stopColor={colors.accent} stopOpacity={0.8} />
            <Stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
          </LinearGradient>
        </Defs>

        {/* ── Signal line (flowing from Monitor to Phone) ── */}
        <AnimatedPath
          d="M 235 65 Q 190 50 145 78"
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="2.5"
          strokeDasharray="4 6"
          animatedProps={signalLineProps}
        />

        {/* ── Phone ── */}
        <G>
          <Rect
            x="80"
            y="30"
            width="50"
            height="90"
            rx="8"
            fill={colors.background}
            stroke={colors.borderStrong}
            strokeWidth="2"
          />
          <Rect
            x="84"
            y="34"
            width="42"
            height="82"
            rx="4"
            fill={colors.background}
            stroke={colors.border}
            strokeWidth="1"
          />

          {/* Desktop App UI on Phone (scaled and letterboxed) */}
          <Rect
            x="84"
            y="62"
            width="42"
            height="26"
            fill={cardFill}
            stroke={colors.borderStrong}
            strokeWidth="0.5"
          />
          <Rect
            x="84"
            y="62"
            width="10"
            height="26"
            fill={colors.border}
          />
          <Rect
            x="97"
            y="65"
            width="26"
            height="2"
            rx="1"
            fill={colors.borderStrong}
          />
          <Rect
            x="97"
            y="69"
            width="18"
            height="1.5"
            rx="0.75"
            fill={colors.border}
          />
          <Rect
            x="97"
            y="73"
            width="22"
            height="1.5"
            rx="0.75"
            fill={colors.border}
          />

          {/* Phone header speaker hole */}
          <Rect
            x="94"
            y="38"
            width="22"
            height="3"
            rx="1.5"
            fill={colors.borderStrong}
          />

          <AnimatedPath
            fill={colors.text}
            stroke={colors.background}
            strokeWidth="0.6"
            strokeLinejoin="round"
            animatedProps={phoneCursorProps}
          />
          <AnimatedCircle
            fill={colors.accent}
            animatedProps={phoneRippleProps}
          />
        </G>

        {/* ── Monitor ── */}
        <G>
          <Path
            d="M285 95 L275 115 H315 L305 95"
            fill={colors.background}
            stroke={colors.borderStrong}
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <Path
            d="M275 115 H315"
            stroke={colors.borderStrong}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <Rect
            x="240"
            y="25"
            width="110"
            height="70"
            rx="6"
            fill={colors.background}
            stroke={colors.borderStrong}
            strokeWidth="2"
          />
          <Rect
            x="244"
            y="29"
            width="102"
            height="62"
            rx="3"
            fill={cardFill}
            stroke={colors.border}
            strokeWidth="1"
          />
          
          {/* Desktop App UI on Monitor */}
          <Rect
            x="244"
            y="29"
            width="25"
            height="62"
            fill={colors.border}
          />
          <Rect
            x="275"
            y="36"
            width="65"
            height="5"
            rx="2.5"
            fill={colors.borderStrong}
          />
          <Rect
            x="275"
            y="46"
            width="45"
            height="4"
            rx="2"
            fill={colors.border}
          />
          <Rect
            x="275"
            y="56"
            width="55"
            height="4"
            rx="2"
            fill={colors.border}
          />

          <AnimatedPath
            fill={colors.text}
            stroke={colors.background}
            strokeWidth="1.5"
            strokeLinejoin="round"
            animatedProps={monitorCursorProps}
          />
          <AnimatedCircle
            fill={colors.accent}
            animatedProps={monitorRippleProps}
          />
        </G>
      </Svg>
    </View>
  );
}
