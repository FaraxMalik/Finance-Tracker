import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';

import { Txt } from '@/components/ui';
import { Radius, type Palette } from '@/constants/theme';
import { useColors, useStyles } from '@/hooks/use-theme';

export type Segment = { value: number; color: string };

/** Thin progress line. */
export function ProgressBar({ fraction, color, height = 3 }: { fraction: number; color?: string; height?: number }) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const f = Math.min(Math.max(fraction, 0), 1);
  return (
    <View style={[styles.track, { height }]}>
      <View style={{ width: `${f * 100}%`, height: '100%', backgroundColor: color ?? c.text }} />
    </View>
  );
}

/** One horizontal bar split into coloured shares. */
export function StackBar({ segments, height = 6 }: { segments: Segment[]; height?: number }) {
  const styles = useStyles(makeStyles);
  const parts = segments.filter((s) => s.value > 0);
  return (
    <View style={[styles.track, { height, flexDirection: 'row', gap: 2 }]}>
      {parts.map((s, i) => (
        <View key={i} style={{ flex: s.value, backgroundColor: s.color }} />
      ))}
    </View>
  );
}

export type Bar = { key: string; value: number; highlight?: boolean };

/** One bar per day of the cycle. Days with no spending get a faint stub so the timeline still reads. */
export function Bars({
  bars,
  labels,
  height = 96,
}: {
  bars: Bar[];
  labels: [string, string, string];
  height?: number;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const max = Math.max(...bars.map((b) => b.value), 1);
  const gap = 3;
  const barW = width > 0 && bars.length > 0 ? Math.max((width - gap * (bars.length - 1)) / bars.length, 2) : 0;

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke={c.border} strokeWidth={1} />
          {bars.map((b, i) => {
            const h = b.value > 0 ? Math.max((b.value / max) * (height - 6), 3) : 2;
            return (
              <Rect
                key={b.key}
                x={i * (barW + gap)}
                y={height - 1 - h}
                width={barW}
                height={h}
                rx={1}
                fill={b.value > 0 ? c.text : c.border}
                fillOpacity={b.value > 0 && !b.highlight ? 0.78 : 1}
              />
            );
          })}
        </Svg>
      ) : (
        <View style={{ height }} />
      )}
      <View style={styles.barLegend}>
        <Txt variant="small">{labels[0]}</Txt>
        <Txt variant="small">{labels[1]}</Txt>
        <Txt variant="small">{labels[2]}</Txt>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    track: { borderRadius: Radius.pill, overflow: 'hidden', backgroundColor: c.surfaceHigh },
    barLegend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  });
