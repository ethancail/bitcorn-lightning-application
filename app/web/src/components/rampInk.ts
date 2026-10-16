// Valuation and Z ramps keep their own hues (colour round, CR-5: contrast
// only). In the light theme they mix toward --text by the share styles.css
// sets per theme, so a ramp colour used as text reaches 4.5:1 and one used as
// a mark reaches 3:1. In dark both shares are 0%, and the colour is unchanged.
export const rampInk = (c: string) => `color-mix(in srgb, ${c}, var(--text) var(--ramp-ink))`;
export const rampMark = (c: string) => `color-mix(in srgb, ${c}, var(--text) var(--ramp-mark))`;
