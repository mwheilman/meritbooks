/** Finger signature → SVG path data (stored with the log). Works with a gloved knuckle too: big pad, thick line. */
import { useMemo, useRef, useState } from 'react';
import { PanResponder, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Button } from './components';
import { color, font, size } from './theme';

export function SignaturePad({ label, clearLabel, onChange }: { label: string; clearLabel: string; onChange: (path: string | null) => void }) {
  const [strokes, setStrokes] = useState<string[]>([]);
  const current = useRef<string>('');
  const [live, setLive] = useState('');
  const box = useRef({ w: 0, h: 0 });

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const { locationX: x, locationY: y } = e.nativeEvent;
          current.current = `M${x.toFixed(1)} ${y.toFixed(1)}`;
          setLive(current.current);
        },
        onPanResponderMove: (e) => {
          const { locationX: x, locationY: y } = e.nativeEvent;
          if (x < 0 || y < 0 || x > box.current.w || y > box.current.h) return;
          current.current += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
          setLive(current.current);
        },
        onPanResponderRelease: () => {
          const stroke = current.current;
          current.current = '';
          setLive('');
          if (!stroke) return;
          setStrokes((prev) => {
            const next = [...prev, stroke];
            onChange(next.join(' ').slice(0, 20_000));
            return next;
          });
        },
      }),
    [onChange],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    box.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={font.strong}>{label}</Text>
      <View
        onLayout={onLayout}
        {...responder.panHandlers}
        accessible
        accessibilityLabel={label}
        style={{ height: 180, borderWidth: 2, borderColor: color.ink, borderRadius: size.radius, backgroundColor: color.bg }}
      >
        <Svg width="100%" height="100%">
          {[...strokes, live].filter(Boolean).map((d, i) => (
            <Path key={i} d={d} stroke={color.ink} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </Svg>
      </View>
      {strokes.length ? (
        <Button
          label={clearLabel}
          onPress={() => {
            setStrokes([]);
            onChange(null);
          }}
        />
      ) : null}
    </View>
  );
}
