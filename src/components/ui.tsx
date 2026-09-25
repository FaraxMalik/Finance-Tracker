import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckIcon, CloseIcon } from '@/components/icons';
import {
  fontForWeight,
  Radius,
  Spacing,
  TabBarClearance,
  withAlpha,
  type FontSet,
  type Palette,
} from '@/constants/theme';
import { useColors, useStyles, useTheme } from '@/hooks/use-theme';
import { tap } from '@/lib/haptics';

// ---------- Text ----------

type Variant = 'body' | 'dim' | 'small' | 'label' | 'title' | 'heading' | 'hero';

function textStyle(variant: Variant, c: Palette, f: FontSet): TextStyle {
  switch (variant) {
    case 'body':
      return { fontSize: 15, color: c.text, fontWeight: '400' };
    case 'dim':
      return { fontSize: 14, color: c.textDim, fontWeight: '400' };
    case 'small':
      return { fontSize: 12, color: c.textDim, fontWeight: '400' };
    case 'label':
      return { fontSize: 11, color: c.textDim, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' };
    case 'heading':
      return { fontSize: 17, color: c.text, fontWeight: '600' };
    case 'title':
      return { fontSize: 28, color: c.text, fontFamily: f.display, letterSpacing: f.displaySpacing * 0.5 };
    case 'hero':
      return { fontSize: 46, color: c.text, fontFamily: f.display, letterSpacing: f.displaySpacing };
  }
}

/** Text with the app fonts. A `fontWeight` in `style` is mapped onto the matching font file. */
export function Txt({ variant = 'body', color, style, ...rest }: TextProps & { variant?: Variant; color?: string }) {
  const { colors: c, fonts } = useTheme();
  const { fontWeight, fontFamily, fontSize, ...flat } = StyleSheet.flatten([
    textStyle(variant, c, fonts),
    style,
  ]) as TextStyle;
  return (
    <Text
      {...rest}
      style={[
        flat,
        // Each typeface is tuned (monospaced ones run slightly smaller so columns still fit).
        fontSize ? { fontSize: Math.round(fontSize * fonts.scale * 2) / 2 } : null,
        { fontFamily: fontFamily ?? fontForWeight(fontWeight, fonts) },
        color ? { color } : null,
      ]}
    />
  );
}

// ---------- Layout ----------

/** Page on the themed background. `tabs` = sits above the tab bar. `footer` is pinned under the scrolling content. */
export function Screen({
  children,
  tabs = false,
  scroll = true,
  style,
  footer,
}: {
  children: ReactNode;
  tabs?: boolean;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  footer?: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const padding = {
    paddingTop: insets.top + Spacing.four,
    paddingBottom: tabs ? TabBarClearance : Spacing.four,
    paddingHorizontal: Spacing.three + 4,
  };
  return (
    <View style={styles.screen}>
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[padding, styles.scrollContent, style]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, padding, style]}>{children}</View>
      )}
      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + Spacing.three }]}>{footer}</View> : null}
    </View>
  );
}

/** Gentle fade-in. Stagger with `index`. */
export function Reveal({
  children,
  index = 0,
  style,
}: {
  children: ReactNode;
  index?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View entering={FadeIn.delay(Math.min(index, 6) * 40).duration(300)} style={style}>
      {children}
    </Animated.View>
  );
}

export function Header({
  title,
  eyebrow,
  subtitle,
  right,
}: {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.header}>
      <View style={{ flex: 1, gap: 2 }}>
        {eyebrow ? <Txt variant="label">{eyebrow}</Txt> : null}
        <Txt variant="title">{title}</Txt>
        {subtitle ? <Txt variant="dim">{subtitle}</Txt> : null}
      </View>
      {right}
    </View>
  );
}

/**
 * Header for modal / detail screens with a close button. Pass `onSave` to add a ✓ button that saves
 * without having to dismiss the keyboard and reach the Save button at the bottom.
 */
export function ModalHeader({
  title,
  subtitle,
  onSave,
  saveDisabled,
}: {
  title: string;
  subtitle?: string;
  onSave?: () => void;
  saveDisabled?: boolean;
}) {
  const router = useRouter();
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.header}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="title">{title}</Txt>
        {subtitle ? <Txt variant="dim">{subtitle}</Txt> : null}
      </View>
      {onSave ? (
        <IconButton
          onPress={onSave}
          accessibilityLabel="Save"
          style={[{ backgroundColor: c.accent, borderColor: c.accent }, saveDisabled && { opacity: 0.4 }]}>
          <CheckIcon color={c.onAccent} size={20} />
        </IconButton>
      ) : null}
      <IconButton onPress={() => router.back()} accessibilityLabel="Close">
        <CloseIcon color={c.text} size={18} />
      </IconButton>
    </View>
  );
}

/** Surface with a hairline border. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.divider, style]} />;
}

export function SectionTitle({ children, right }: { children: string; right?: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.sectionTitle}>
      <Txt variant="label" style={{ flex: 1 }}>
        {children}
      </Txt>
      {right}
    </View>
  );
}

export function Empty({ children, icon }: { children: string; icon?: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.empty}>
      {icon}
      <Txt variant="dim" style={{ textAlign: 'center' }}>
        {children}
      </Txt>
    </View>
  );
}

/** Neutral round badge holding initials or an icon. */
export function Avatar({ children, size = 40 }: { children: ReactNode; size?: number }) {
  const c = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: c.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      {children}
    </View>
  );
}

/** Small filled dot for a category colour. */
export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

// ---------- Controls ----------

/** Pressable that fades slightly while pressed. */
export function Press({
  children,
  onPress,
  style,
  disabled,
  haptic = true,
  ...rest
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  haptic?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      {...rest}
      accessibilityRole="button"
      disabled={disabled || !onPress}
      onPress={() => {
        if (haptic) tap();
        onPress?.();
      }}
      style={({ pressed }) => [style, pressed && { opacity: 0.6 }]}>
      {children}
    </Pressable>
  );
}

export function IconButton({
  children,
  onPress,
  accessibilityLabel,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Press onPress={onPress} accessibilityLabel={accessibilityLabel} style={[styles.iconButton, style]}>
      {children}
    </Press>
  );
}

/** Primary = solid accent. Ghost = hairline outline. Danger = red outline. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  style,
  icon,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: ReactNode;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const fill =
    variant === 'primary'
      ? { backgroundColor: c.accent, borderColor: c.accent }
      : variant === 'danger'
        ? { backgroundColor: 'transparent', borderColor: c.danger }
        : { backgroundColor: 'transparent', borderColor: c.border };
  const textColor = variant === 'primary' ? c.onAccent : variant === 'danger' ? c.danger : c.text;

  return (
    <Press onPress={onPress} disabled={disabled} style={[styles.button, fill, disabled && { opacity: 0.35 }, style]}>
      {icon}
      <Txt style={{ fontWeight: '600', color: textColor }}>{label}</Txt>
    </Press>
  );
}

/** Selectable pill. Selected = solid accent. `dot` shows a category colour. */
export function Chip({
  label,
  selected,
  onPress,
  dot,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  dot?: string;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Press
      onPress={onPress}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: c.accent, borderColor: c.accent }
          : { borderColor: c.border, backgroundColor: c.surface },
      ]}>
      {dot ? <Dot color={dot} size={7} /> : null}
      <Txt variant="dim" style={{ color: selected ? c.onAccent : c.text, fontWeight: '600' }}>
        {label}
      </Txt>
    </Press>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.chipRow}>{children}</View>;
}

export function Field({ label, optional, ...input }: TextInputProps & { label: string; optional?: boolean }) {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: Spacing.two }}>
      <Txt variant="label">
        {label}
        {optional ? <Txt variant="small">{'   optional'}</Txt> : null}
      </Txt>
      <TextInput
        placeholderTextColor={withAlpha(c.textDim, 0.6)}
        selectionColor={c.text}
        {...input}
        onFocus={(e) => {
          setFocused(true);
          input.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          input.onBlur?.(e);
        }}
        style={[styles.input, { fontFamily: fonts.regular }, focused && { borderColor: c.text }, input.style]}
      />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    scrollContent: { gap: Spacing.four - 4 },
    footer: {
      paddingHorizontal: Spacing.three + 4,
      paddingTop: Spacing.three,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.bg,
      gap: Spacing.two,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    card: {
      backgroundColor: c.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      padding: Spacing.three + 2,
      gap: Spacing.two + 2,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    divider: { height: 1, backgroundColor: c.border },
    sectionTitle: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.two },
    empty: { paddingVertical: Spacing.four, paddingHorizontal: Spacing.three, alignItems: 'center', gap: Spacing.two },
    iconButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    button: {
      minHeight: 52,
      borderRadius: Radius.md,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.two,
      paddingHorizontal: Spacing.three,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: Radius.pill,
      borderWidth: 1,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
    input: {
      minHeight: 50,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      color: c.text,
      fontSize: 16,
      paddingHorizontal: Spacing.three,
    },
  });
