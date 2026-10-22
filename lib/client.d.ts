/**
 * Type declarations for the dsh-modeltrace browser half.
 *
 * These are descriptive only: the runtime loads `./client.js`, which is a
 * hand-written lazy-CJS bundle (`window.__ModuleLoader__.load({ id, factory })`).
 * Nothing here is compiled, so the file deliberately imports no module that may
 * be absent from an installed profile.
 */

/** One rendered setting, mirroring the fields of `SettingsSchema` in `lib/config.js`. */
export interface ModelTraceField {
    key: string;
    type: 'boolean' | 'enum' | 'number';
    label: string;
    hint: string;
    options?: ReadonlyArray<{ value: string; label: string }>;
    min?: number;
    max?: number;
    step?: number | 'any';
    nullable?: boolean;
    /** Host schema stores optional intervals as strings; empty means unset. */
    stringValue?: boolean;
}

/** Schema defaults, kept in lockstep with `SettingsSchema`. */
export declare const DEFAULTS: Readonly<Record<string, boolean | string | number | null>>;

/** The editable settings rendered by the card, in display order. */
export declare const FIELDS: ReadonlyArray<ModelTraceField>;

/** Settings namespace served by the host half (`SETTINGS_NAMESPACE` in `lib/config.js`). */
export declare const SETTINGS_NAMESPACE: 'modeltrace';

/** Props handed to the card component: `scope` is injected by the plugin entry wrapper. */
export interface ModelTraceCardProps {
    /** `'summary'` on the Plugins page, `'page'` on a dedicated page; absent in some shells. */
    view?: 'summary' | 'page';
    busy?: boolean;
    scope?: unknown;
    [key: string]: unknown;
}

/**
 * Card component registered into the `plugins.item` and `settings.plugins.tab` slot under the
 * `modeltrace` namespace. Renders a compact summary for `view === 'summary'` and
 * the full form otherwise.
 */
export declare function ModelTraceCard(props: ModelTraceCardProps): unknown;

export declare const name: 'dsh-modeltrace';
export declare const inject: string[];
export declare function apply(ctx: unknown): void;

/** Bound to the official session-scoped conversation header slot. */
export interface ModelTraceWindowProps {
    sessionId: string;
    scope?: unknown;
}
export declare function ModelTraceWindow(props: ModelTraceWindowProps): unknown;
