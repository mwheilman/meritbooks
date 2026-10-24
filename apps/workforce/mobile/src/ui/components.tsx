/** Field UI parts: big targets, plain words, main actions at the bottom. */
import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, font, size } from './theme';

export function Screen({ title, right, children, footer, overlay, scroll = true }: { title: string; right?: ReactNode; children: ReactNode; footer?: ReactNode; overlay?: ReactNode; scroll?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header" numberOfLines={1}>{title}</Text>
        {right}
      </View>
      {scroll ? (
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      ) : (
        <View style={[s.body, { flex: 1 }]}>{children}</View>
      )}
      {footer ? <View style={s.footer}>{footer}</View> : null}
      {overlay}
    </View>
  );
}

type Tone = 'primary' | 'secondary' | 'danger' | 'ok';

export function Button({ label, onPress, tone = 'secondary', disabled, busy, big, accessibilityHint }: {
  label: string; onPress: () => void; tone?: Tone; disabled?: boolean; busy?: boolean; big?: boolean; accessibilityHint?: string;
}) {
  const filled = tone !== 'secondary';
  const bg = tone === 'primary' ? color.primary : tone === 'danger' ? color.danger : tone === 'ok' ? color.ok : color.bg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      hitSlop={8}
      style={({ pressed }) => [
        s.button, big && s.big, { backgroundColor: bg, borderColor: filled ? bg : color.ink },
        (disabled || busy) && { opacity: 0.5 }, pressed && { opacity: 0.8 },
      ]}
    >
      {busy ? <ActivityIndicator color={filled ? color.onPrimary : color.ink} /> : (
        <Text style={[s.buttonText, big && { fontSize: 24 }, { color: filled ? color.onPrimary : color.ink }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Card({ children, tone }: { children: ReactNode; tone?: 'sky' | 'warn' | 'danger' | 'ok' }) {
  const bg = tone === 'sky' ? color.sky : tone === 'warn' ? color.warnBg : tone === 'danger' ? color.dangerBg : tone === 'ok' ? color.okBg : color.bg;
  return <View style={[s.card, { backgroundColor: bg }]}>{children}</View>;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: size.gap }}>
      <View style={s.sectionHead}>
        <Text style={font.eyebrow} accessibilityRole="header">{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

export function Body({ children, muted, strong }: { children: ReactNode; muted?: boolean; strong?: boolean }) {
  return <Text style={strong ? font.strong : muted ? font.muted : font.regular}>{children}</Text>;
}

export function Notice({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'danger' | 'ok' | 'sky' }) {
  const fg = tone === 'danger' ? color.danger : tone === 'ok' ? color.ok : tone === 'sky' ? color.ink : color.warn;
  const bg = tone === 'danger' ? color.dangerBg : tone === 'ok' ? color.okBg : tone === 'sky' ? color.sky : color.warnBg;
  return (
    <View style={[s.notice, { backgroundColor: bg, borderColor: fg }]} accessibilityRole={tone === 'danger' ? 'alert' : undefined}>
      <Text style={[font.regular, { color: fg }]}>{text}</Text>
    </View>
  );
}

/** A full-width row you tap (job picker, list items). 56 pt minimum. */
export function Row({ title, sub, right, onPress, selected }: { title: string; sub?: string | null; right?: ReactNode; onPress?: () => void; selected?: boolean }) {
  const content = (
    <>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={font.strong} numberOfLines={2}>{title}</Text>
        {sub ? <Text style={font.muted} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {right}
    </>
  );
  if (!onPress) return <View style={[s.row, selected && s.rowOn]}>{content}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!selected }} style={({ pressed }) => [s.row, selected && s.rowOn, pressed && { backgroundColor: color.faint }]}>
      {content}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      <Text style={font.strong}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.muted}
        {...rest}
        style={[s.input, rest.multiline && { minHeight: 160, textAlignVertical: 'top', paddingTop: 14 }, style]}
      />
    </View>
  );
}

/** Pass / Fail / N/A style choice: big, side by side. */
export function Choice<T extends string>({ options, value, onChange }: { options: ReadonlyArray<{ value: T; label: string; tone?: Tone }>; value: T | null; onChange: (v: T) => void }) {
  return (
    <View style={s.choice} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        const bg = on ? (o.tone === 'danger' ? color.danger : o.tone === 'ok' ? color.ok : color.primary) : color.bg;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={o.label}
            style={({ pressed }) => [s.choiceItem, { backgroundColor: bg, borderColor: on ? bg : color.ink }, pressed && { opacity: 0.85 }]}>
            <Text style={[s.buttonText, { fontSize: 22, color: on ? color.onPrimary : color.ink }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Pill({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'primary' }) {
  const fg = tone === 'ok' ? color.ok : tone === 'warn' ? color.warn : tone === 'danger' ? color.danger : tone === 'primary' ? color.primary : color.muted;
  return (
    <View style={[s.pill, { borderColor: fg }]}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: fg }}>{text}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  header: { minHeight: 64, paddingHorizontal: size.gutter, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottomWidth: 1, borderBottomColor: color.line },
  body: { padding: size.gutter, gap: 24, paddingBottom: 120 },
  footer: { padding: size.gutter, paddingBottom: size.gutter, gap: size.gap, borderTopWidth: 1, borderTopColor: color.line, backgroundColor: color.bg },
  button: { minHeight: size.target, paddingHorizontal: 20, borderWidth: 2, borderRadius: size.radius, alignItems: 'center', justifyContent: 'center' },
  big: { minHeight: size.bigButton },
  buttonText: { fontSize: 20, fontWeight: '700' },
  card: { borderWidth: 1, borderColor: color.line, borderRadius: size.radius, padding: size.gutter, gap: 8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 },
  notice: { borderLeftWidth: 4, padding: 14, borderRadius: size.radius },
  row: { minHeight: size.target + 8, paddingVertical: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: color.line, borderRadius: size.radius, backgroundColor: color.bg },
  rowOn: { borderColor: color.primary, borderWidth: 2, backgroundColor: color.sky },
  input: { minHeight: size.target, borderWidth: 2, borderColor: color.ink, borderRadius: size.radius, paddingHorizontal: 14, fontSize: size.body, color: color.ink, backgroundColor: color.bg },
  choice: { flexDirection: 'row', gap: 10 },
  choiceItem: { flex: 1, minHeight: 72, borderWidth: 2, borderRadius: size.radius, alignItems: 'center', justifyContent: 'center' },
  pill: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
});
