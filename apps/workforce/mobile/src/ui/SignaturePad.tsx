/**
 * Finger signature → SVG path data (stored with the log). Works with a gloved knuckle too: big pad,
 * thick line. `exportRef` gives a PNG (base64) of the drawing for e-sign and the field-service sale.
 */
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { PanResponder, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Button } from './components';
import { color, font, size } from './theme';

export interface SignatureExport {
  /** Base64 PNG of the drawing (no data: prefix), or null when nothing is drawn or the export failed. */
  png: () => Promise<string | null>;
}

interface SvgWithExport {
  toDataURL: (callback: (base64: string) => void, options?: object) => void;
}

export function SignaturePad({ label, clearLabel, onChange, exportRef }: { label: string; clearLabel: string; onChange: (path: string | null) => void; exportRef?: Ref<SignatureExport> }) {
  const [strokes, setStrokes] = useState<string[]>([]);
  const svg = useRef<SvgWithExport | null>(null);
  useImperativeHandle(exportRef, () => ({
    png: () => new Promise<string | null>((resolve) => {
      if (!strokes.length || !svg.current) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => resolve(null), 4000);
      try {
        svg.current.toDataURL((b64) => {
          clearTimeout(timer);
          resolve(b64 || null);
        }, { width: 600, height: 240 });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    }),
  }), [strokes.length]);
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
        <Svg width="100%" height="100%" ref={(r: unknown) => { svg.current = r as SvgWithExport | null; }}>
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
