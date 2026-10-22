import { Conf, Meter, scoreStrokes } from '@meritbooks/merit-ui';

interface ConfidenceBarProps {
  value: number; // 0-1
  showLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * AI confidence on merit-ui: the slash meter + the number (kit `<Conf>`); under 70
 * (the Decide band) it turns ochre. Same props as the old bar (value is 0–1).
 */
export function ConfidenceBar({ value, showLabel = true, size = 'sm', className }: ConfidenceBarProps) {
  const score = Math.max(0, Math.min(100, Math.round((Number.isFinite(value) ? value : 0) * 100)));
  if (!showLabel) {
    return <Meter strokes={scoreStrokes(score)} label={`Confidence ${score} of 100`} size={size === 'md' ? 'lg' : 'md'} className={className} />;
  }
  return <Conf score={score} className={className} />;
}
