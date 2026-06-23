<!--
  ============================================================================
  VULTUS DESIGN SYSTEM — SINGLE SOURCE OF TRUTH
  ============================================================================
  Exported from Google Stitch "Vultus Android App Design"
  (project projects/13590348714018893783) via the `stitch` MCP.

  AUTHORITY (read this before using any value below):

  * The machine-readable YAML frontmatter (`colors:`, `typography:`,
    `rounded:`, `spacing:`) is THE AUTHORITATIVE token set. Wire these values —
    and only these — into libs/shared/ui-kit/src/lib/theme.scss. Never
    hand-transcribe a hex value from memory or from PLAN §2 prose; cite this
    file or the fetched Stitch screen.

  * The prose sections below are descriptive design intent, NOT a token source.
    Stitch's own prose lagged behind its tokens (it still narrates the old
    "Emerald #10B981 / background #0F172A" palette); where prose named a stale
    hex it has been corrected inline as `#new (was #old — stale prose)` so the
    wrong value cannot be re-transcribed. When prose and frontmatter disagree,
    the FRONTMATTER WINS.

  * `primary` is #4edea3. The value #10B981 is `primary-container`, a different
    token — do not use it as the primary accent.

  Keep this file in sync when the Stitch design system changes: re-export and
  re-run the theme.scss mapping. This is the contract CLAUDE.md, the
  frontend-engineer agent, and the spec-author agent all point at.
  ============================================================================
-->

---

name: Vultus Design System
colors:
surface: '#0b1326'
surface-dim: '#0b1326'
surface-bright: '#31394d'
surface-container-lowest: '#060e20'
surface-container-low: '#131b2e'
surface-container: '#171f33'
surface-container-high: '#222a3d'
surface-container-highest: '#2d3449'
on-surface: '#dae2fd'
on-surface-variant: '#bbcabf'
inverse-surface: '#dae2fd'
inverse-on-surface: '#283044'
outline: '#86948a'
outline-variant: '#3c4a42'
surface-tint: '#4edea3'
primary: '#4edea3'
on-primary: '#003824'
primary-container: '#10b981'
on-primary-container: '#00422b'
inverse-primary: '#006c49'
secondary: '#45dfa4'
on-secondary: '#003825'
secondary-container: '#00bd85'
on-secondary-container: '#00452e'
tertiary: '#68dba9'
on-tertiary: '#003825'
tertiary-container: '#3eb686'
on-tertiary-container: '#00422c'
error: '#ffb4ab'
on-error: '#690005'
error-container: '#93000a'
on-error-container: '#ffdad6'
primary-fixed: '#6ffbbe'
primary-fixed-dim: '#4edea3'
on-primary-fixed: '#002113'
on-primary-fixed-variant: '#005236'
secondary-fixed: '#68fcbf'
secondary-fixed-dim: '#45dfa4'
on-secondary-fixed: '#002114'
on-secondary-fixed-variant: '#005137'
tertiary-fixed: '#85f8c4'
tertiary-fixed-dim: '#68dba9'
on-tertiary-fixed: '#002114'
on-tertiary-fixed-variant: '#005137'
background: '#0b1326'
on-background: '#dae2fd'
surface-variant: '#2d3449'
status-watching: '#3B82F6'
status-completed: '#10B981'
status-dropped: '#EF4444'
status-planned: '#94A3B8'
surface-dark: '#1E293B'
surface-light: '#F8FAFC'
typography:
display-lg:
fontFamily: Inter
fontSize: 32px
fontWeight: '700'
lineHeight: 40px
letterSpacing: -0.02em
headline-md:
fontFamily: Inter
fontSize: 24px
fontWeight: '600'
lineHeight: 32px
headline-sm:
fontFamily: Inter
fontSize: 20px
fontWeight: '600'
lineHeight: 28px
body-lg:
fontFamily: Inter
fontSize: 16px
fontWeight: '400'
lineHeight: 24px
body-md:
fontFamily: Inter
fontSize: 14px
fontWeight: '400'
lineHeight: 20px
label-md:
fontFamily: Inter
fontSize: 12px
fontWeight: '600'
lineHeight: 16px
letterSpacing: 0.05em
label-sm:
fontFamily: Inter
fontSize: 11px
fontWeight: '500'
lineHeight: 16px
display-lg-mobile:
fontFamily: Inter
fontSize: 28px
fontWeight: '700'
lineHeight: 36px
rounded:
sm: 0.25rem
DEFAULT: 0.5rem
md: 0.75rem
lg: 1rem
xl: 1.5rem
full: 9999px
spacing:
base: 4px
xs: 4px
sm: 8px
md: 16px
lg: 24px
xl: 32px
gutter: 16px
margin-mobile: 16px
margin-tablet: 32px

---

## Brand & Style

The brand personality is **utilitarian, professional, and precise**. As a tracking tool, it prioritizes content over decoration, acting as a high-fidelity lens for the user's media library. The UI is designed to be "invisible" until needed, allowing movie posters and TV show art to provide the primary visual energy.

The design style is **Corporate / Modern** with a lean towards **Minimalism**. It utilizes heavy whitespace, a strict geometric grid, and high-contrast elements to ensure readability on the go. The aesthetic is inspired by modern Android Material 3 principles but stripped of excess ornamentation to focus on data density and speed. The "Vibrant Emerald" serves as a functional signal for "active" or "completed" states, providing a refreshing departure from standard "streaming blue" or "cinema red" palettes.

## Colors

The system uses a **Dark-First** approach to mirror the cinematic experience of viewing media.

- **Primary Emerald (`#4edea3` — was #10B981, stale prose; #10B981 is `primary-container`):** Used for high-priority interactive elements, active pills, progress, and accents. Its on-color is `on-primary` `#003824`.
- **Surface Strategy:** In dark mode, the background is a deep navy `#0b1326` (was #0F172A, stale prose) to reduce eye strain, while cards and containers step up a **tonal surface ramp** — `surface-container-low #131b2e`, `surface-container #171f33`, `surface-container-high #222a3d`, `surface-container-highest #2d3449` — rather than a single "elevated" slate. Elevation = a step up this ramp.
- **Semantic Status:**
  - **Watching:** Electric Blue `#3B82F6` for active engagement.
  - **Planned:** Neutral Slate `#94A3B8` for low-priority future actions.
  - **Dropped:** Muted Red `#EF4444` for archival or negative states.
  - **Completed:** Emerald `#10B981` (the `status-completed` token).
- **Contrast:** Text maintains high legibility with `on-surface` `#dae2fd` (was #F8FAFC, stale prose) for primary content and `on-surface-variant` `#bbcabf` for metadata.

## Typography

This design system utilizes **Inter** across all levels to maintain a systematic, utilitarian feel. The font must be **loaded as a web-font** (Google Fonts link in `apps/mobile/src/index.html`), not merely named in a family stack — otherwise it silently falls back to system-ui.

- **Headlines:** Use tight letter-spacing and bold weights to create a strong visual anchor for movie titles (`headline-sm` 20/600, `headline-md` 24/600).
- **Labels:** `label-md` (12/600, +0.05em) and `label-sm` (11/500) for category tags, counts, and metadata chips.
- **Body:** `body-lg` (16/400/24) for titles in lists, `body-md` (14/400/20) for descriptions.
- **Scaling:** On mobile devices, the largest display type scales down to `display-lg-mobile` 28px to ensure titles don't wrap excessively.

## Layout & Spacing

The layout follows an **8px grid system** (4px base) for consistent rhythm.

- **Grid Model:** A 12-column fluid grid is used for tablet and desktop, while mobile uses a single-column vertical stack with 16px side margins (`margin-mobile`).
- **Watchlist/Search Results:** Content is displayed in a "Dense List" or "Standard Grid" (2 columns on mobile, 4-6 on tablet).
- **Vertical Spacing:** 16px (`md`) is the standard gap between cards. 8px (`sm`) is used for internal card elements (e.g., title to metadata).
- **Safe Areas:** Adhere to Android system bars and gestures, ensuring the bottom navigation does not interfere with the OS navigation bar.

## Elevation & Depth

Visual hierarchy is achieved through **Tonal Layers** rather than heavy shadows, keeping the UI modern and flat.

- **Level 0 (Background):** `surface` / `background` `#0b1326` (was #0F172A, stale prose).
- **Level 1 (Cards/Search Bar):** `surface-container` `#171f33` (was #1E293B, stale prose). These elements use a 1px low-contrast `outline-variant` `#3c4a42` (was #334155, stale prose) — or rely on the surface-step contrast alone — to define boundaries.
- **Level 2 (Modals/Overlays):** `surface-container-highest` `#2d3449` (was #2D3748, stale prose) with a soft, diffused ambient shadow (10% opacity, 16px blur) to indicate temporary interaction layers.
- **Interactions:** When an item is pressed, it uses a subtle primary-tinted overlay (5% Emerald) rather than a physical "lift" effect, maintaining the flat professional aesthetic.

## Shapes

The design system uses a **Rounded** (0.5rem) shape language.

- **Cards & Inputs:** Standard 8px (0.5rem) radius (`rounded.DEFAULT`); cards often use `md` 0.75rem.
- **Posters:** Movie posters within cards should maintain this radius to feel integrated.
- **Pills/Tags:** Use `full` (9999px) for status pills, filter pills, and availability badges to create a clear visual distinction from square-ish content blocks.
- **Bottom Navigation:** The active indicator behind icons is a pill-shaped "capsule" to provide a soft, modern touchpoint.

## Components

### Buttons

- **Primary:** Solid `primary` `#4edea3` with `on-primary` `#003824` text. Bold weight.
- **Secondary:** Outlined Emerald with 1px border. No fill.
- **Ghost:** Text-only for less frequent actions like "View All".

### Filter / Tab Pills

- A **flex row of individually-rounded pills** (not a single segmented container with a background). Active pill: `primary` `#4edea3` fill, `on-primary` `#003824` text. Inactive pill: `surface-container-high` `#222a3d` fill, `on-surface-variant` `#bbcabf` text. `label-md` type, sized to content (not full-width).

### Cards

- **Media Card:** Features a fixed-aspect-ratio poster (2:3) on the left. Background is a `surface-container` step (passive states sit one step lower, e.g. planned on `surface-container-low #131b2e`). No shadows; contrast comes from the surface step, not a heavy border.
- **Status Badges / Availability:** A planned item shows an availability pill (`bg-primary/10`, `text-primary`) naming where it streams, rather than a generic status chip; status itself is conveyed by the section grouping.

### Search Bar

- **Styling:** `surface-container` fill, 8px rounded corners, magnifying glass icon on the left. Text placeholder is `on-surface-variant`.
- **Interaction:** On focus, the border transitions to `primary` Emerald.

### Bottom Navigation

- **Architecture:** Fixed to the bottom. Uses a `surface-container` step with a subtle top border.
- **Active State:** The icon sits within a subtle emerald-tinted pill; the label below becomes Emerald and increases weight.

### Input Fields

- **Styling:** Understated `surface-container` fill. Labels are positioned above the field in `label-md` style. Error states use the Status-Dropped red for both border and helper text.
