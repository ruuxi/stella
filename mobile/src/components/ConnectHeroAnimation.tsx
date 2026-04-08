/**
 * Phone ↔ desktop bridge hero — same SVG layout as desktop ConnectHeroAnimation,
 * with matching animations driven by Reanimated.
 *
 * Transform props (translateX/Y, rotation) on react-native-svg G elements are NOT
 * natively settable, so useAnimatedProps silently ignores them. Instead we animate
 * only true native SVG props: d, cx, cy, r, opacity, strokeDashoffset.
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
import { colors } from "../theme/colors";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

const VB_W = 400;
const VB_H = 140;
const CARD_FILL = "rgba(255, 255, 255, 0.42)";

export function ConnectHeroAnimation() {
  const uid = useId().replace(/:/g, "");
  const gradId = `signal-grad-${uid}`;
  const { width: windowWidth } = useWindowDimensions();
  const maxW = Math.min(windowWidth - 32, 440);
  const scale = maxW / VB_W;

  /* ── animation drivers ── */
  const signalOffset = useSharedValue(0);
  const pulseVal = useSharedValue(0);
  const cursorVal = useSharedValue(0);

  useEffect(() => {
    // Signal dashes flow: 1.5s linear
    signalOffset.value = withRepeat(
      withTiming(-10, { duration: 1500, easing: Easing.linear }),
      -1,
      false,
    );
    // Pulse circle: 2s (1s each way)
    pulseVal.value = withRepeat(
      withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
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

  // Pulse circle: breathing r + opacity
  const pulseCircleProps = useAnimatedProps(() => ({
    r: interpolate(pulseVal.value, [0, 1], [14, 21]),
    opacity: interpolate(pulseVal.value, [0, 1], [0.1, 0.25]),
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

  // Monitor click ripple (fires at 20-35%)
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

  // Phone cursor (finger): animate path d (M is absolute, rest relative)
  const phoneCursorProps = useAnimatedProps(() => {
    const p = cursorVal.value;
    const tx = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [10, 10, 10, 0, 0, 10],
    );
    const ty = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [25, 25, 25, 0, 0, 25],
    );
    return {
      d: `M${106 + tx} ${71 + ty}v-6a2 2 0 0 0-4 0v10.5l-1.5-1.5a2 2 0 0 0-2.8 2.8l4.8 4.8a5 5 0 0 0 7 0l1.5-1.5a2 2 0 0 0 0-2.8z`,
    };
  });

  // Phone click ripple (offset by 50% = 2s delay in 4s cycle)
  const phoneRippleProps = useAnimatedProps(() => {
    const p = cursorVal.value;
    const tx = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [10, 10, 10, 0, 0, 10],
    );
    const ty = interpolate(
      p,
      [0, 0.2, 0.4, 0.6, 0.8, 1],
      [25, 25, 25, 0, 0, 25],
    );
    const sp = (p + 0.5) % 1;
    return {
      cx: 105 + tx,
      cy: 78 + ty,
      r: interpolate(sp, [0, 0.2, 0.25, 0.35, 1], [2, 2, 10, 15, 15]),
      opacity: interpolate(sp, [0, 0.2, 0.25, 0.35, 1], [0, 0, 0.3, 0, 0]),
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
            fill={CARD_FILL}
            stroke={colors.border}
            strokeWidth="1"
          />
          <Rect
            x="94"
            y="44"
            width="22"
            height="4"
            rx="2"
            fill={colors.borderStrong}
          />
          <Rect
            x="94"
            y="54"
            width="16"
            height="4"
            rx="2"
            fill={colors.border}
          />

          <AnimatedCircle
            cx="105"
            cy="78"
            fill={colors.accent}
            animatedProps={pulseCircleProps}
          />
          <Circle cx="105" cy="78" r="5" fill={colors.accent} />

          <AnimatedPath
            fill={colors.text}
            stroke={colors.background}
            strokeWidth="1.5"
            strokeLinejoin="round"
            animatedProps={phoneCursorProps}
          />
          <AnimatedCircle
            fill={colors.accent}
            animatedProps={phoneRippleProps}
          />
        </G>

        {/* ── Signal line ── */}
        <AnimatedPath
          d="M 145 78 Q 190 50 235 65"
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="2.5"
          strokeDasharray="4 6"
          animatedProps={signalLineProps}
        />

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
            fill={CARD_FILL}
            stroke={colors.border}
            strokeWidth="1"
          />
          <Rect
            x="254"
            y="38"
            width="40"
            height="5"
            rx="2.5"
            fill={colors.borderStrong}
          />
          <Rect
            x="254"
            y="50"
            width="30"
            height="4"
            rx="2"
            fill={colors.border}
          />
          <Rect
            x="254"
            y="60"
            width="60"
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
