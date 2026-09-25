import type { ColorValue } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

type IconProps = { size?: number; color: ColorValue; strokeWidth?: number };

const base = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const });

const line = { strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function HomeIcon({ size = 24, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        {...line}
      />
    </Svg>
  );
}

export function CardIcon({ size = 24, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Rect x={2.5} y={5} width={19} height={14} rx={3} stroke={color} strokeWidth={strokeWidth} />
      <Path d="M2.5 10h19" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M6 15h4" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

export function PeopleIcon({ size = 24, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Circle cx={9} cy={8} r={3.5} stroke={color} strokeWidth={strokeWidth} />
      <Path d="M2.5 20c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6" stroke={color} strokeWidth={strokeWidth} {...line} />
      <Path
        d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.4c2.2.7 3.5 2.6 3.5 5.6"
        stroke={color}
        strokeWidth={strokeWidth}
        {...line}
      />
    </Svg>
  );
}

export function HistoryIcon({ size = 24, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.2L3.5 8.5" stroke={color} strokeWidth={strokeWidth} {...line} />
      <Path d="M3.5 3.5v5h5M12 7.5V12l3 2" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

export function PlusIcon({ size = 24, color, strokeWidth = 2 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

export function CogIcon({ size = 24, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        stroke={color}
        strokeWidth={strokeWidth}
        {...line}
      />
    </Svg>
  );
}

export function TrashIcon({ size = 24, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"
        stroke={color}
        strokeWidth={strokeWidth}
        {...line}
      />
    </Svg>
  );
}

export function ChevronIcon({ size = 20, color, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="m9 5 7 7-7 7" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

export function CloseIcon({ size = 22, color, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M6 6l12 12M18 6 6 18" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

/** Money coming in. */
export function ArrowDownIcon({ size = 24, color, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 4v15M6 13l6 6 6-6" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

/** Money going out. */
export function ArrowUpIcon({ size = 24, color, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 20V5M6 11l6-6 6 6" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

export function CheckIcon({ size = 24, color, strokeWidth = 2 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="m5 12.5 4.5 4.5L19 7.5" stroke={color} strokeWidth={strokeWidth} {...line} />
    </Svg>
  );
}

export function ShareIcon({ size = 24, color, strokeWidth = 1.7 }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M12 15V3M7.5 7.5 12 3l4.5 4.5M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"
        stroke={color}
        strokeWidth={strokeWidth}
        {...line}
      />
    </Svg>
  );
}
