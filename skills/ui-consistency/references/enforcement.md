# Per-repo drift enforcement

Load this when the user asks how to stop kit and token drift in CI, or when the same finding has come back in a second edit.
Propose the config. Do not install a package, and do not edit the user's lint config, unless they ask.
Replace every path below with the repo's own kit directory and token file.
The project's kit, tokens, and conventions win over any pattern here.
Exempt the kit directory from every rule. Kit files legitimately use raw elements and arbitrary values.

Ordered by how much drift each one blocks per unit of setup.

## 1. better-tailwindcss

Package: `eslint-plugin-better-tailwindcss`.
`entryPoint` is the token CSS from `components.json` (`tailwind.css`). It is a common option, also settable under `settings["better-tailwindcss"]`.
For a Tailwind v3 JS config, use `tailwindConfig` instead of `entryPoint`.

`no-unknown-classes` rejects utilities the token CSS does not generate.
`no-restricted-classes` rejects raw palette steps and arbitrary values. `restrict` entries are regexes, and may carry `message` and `fix` (`$1`, `$2`, …).
`enforce-canonical-classes` rewrites an arbitrary value to the scale step when one exists. Set `rootFontSize` to the project's root font size, or the `mt-[16px]` → `mt-4` fix does not run. The documented default of `rootFontSize` is unset.
`logical` defaults to `true` and rewrites physical utilities to logical ones while collapsing. Set `logical: false` when the project writes `ml-` / `mr-`. The option name is `logical`, not `logicalToPhysical`.
`collapse` defaults to `true`. Leave it.

```js
import betterTailwindcss from "eslint-plugin-better-tailwindcss";

const kit = "src/components/ui/**"; // aliases.ui

export default [
  {
    files: ["**/*.{js,jsx,ts,tsx,vue,svelte}"],
    plugins: { "better-tailwindcss": betterTailwindcss },
    settings: {
      "better-tailwindcss": {
        entryPoint: "src/app/globals.css",
      },
    },
    rules: {
      "better-tailwindcss/no-unknown-classes": "error",
      "better-tailwindcss/no-restricted-classes": ["error", {
        restrict: [
          {
            pattern: "^([a-zA-Z0-9:/_-]*:)?(bg|text)-green-500(/[0-9]{1,3})?$",
            message: "Use a semantic token, not a raw palette step.",
            fix: "$1$2-success$3",
          },
          {
            pattern: "^([a-zA-Z0-9:/_-]*:)?(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y)-\\[[0-9.]+(px|rem)\\]$",
            message: "Off-scale spacing. Use the spacing scale.",
          },
          {
            pattern: "^([a-zA-Z0-9:/_-]*:)?(bg|text|border|ring|fill|stroke)-\\[(#[0-9a-fA-F]{3,8}|oklch\\([^\\]]+\\)|rgba?\\([^\\]]+\\))\\]$",
            message: "Arbitrary color. Use a semantic token.",
          },
        ],
      }],
      "better-tailwindcss/enforce-canonical-classes": ["error", {
        rootFontSize: 16,
        logical: false,
      }],
    },
  },
  {
    files: [kit],
    rules: {
      "better-tailwindcss/no-restricted-classes": "off",
    },
  },
];
```

Map `fix` targets only to tokens the project defines. `green-500` → `success` is an example, not a default.
A blanket `\[…\](?!:)` ban also rejects layout widths, viewport units, and grid templates. Start with the spacing and color patterns above.
`var()` and `theme()` do not match those patterns, so they stay allowed.
Turn the rule off for the kit. Do not try to exempt it with a negative regex.

## 2. Tailwind v4 theme namespace resets

One namespace at a time, inside `@theme`. The `*` syntax is the documented reset.

```css
@theme {
  --color-*: initial;
  --font-*: initial;
  --text-*: initial;
  --radius-*: initial;
  --shadow-*: initial;
  /* the project's own tokens follow */
}
```

After `--color-*: initial`, `bg-red-500` is gone and only the colors you define remain.
Do not use a global reset in an existing app:

```css
@theme {
  --*: initial;
}
```

That removes `--breakpoint-*`, `--ease-*`, `--spacing`, and every other default namespace. Breakpoints and easing disappear with them.

Spacing does not close this way. Tailwind's default `theme.css` sets `--spacing: 0.25rem`, and numeric utilities multiply it, so `p-13` is `calc(var(--spacing) * 13)`.
`--spacing-*: initial` does not remove that multiplier. `p-13` still exists.
Ban the off-scale steps with `no-restricted-classes`, listing the steps the project does not use.

## 3. Raw elements and primitive imports

`react/forbid-elements` takes `forbid`, an array of element names or `{ element, message }`.
`no-restricted-imports` takes `paths` for an exact module and `patterns[].group` for a glob.
List only the packages the kit actually imports. Do not ban every primitive on npm.
Do not forbid `<input>` outright. `type="file"` and `type="hidden"` usually have no kit equivalent. Forbid `button`, `select`, `textarea`, and `dialog`, and forbid `input` only for the types the kit's Input covers.

```js
export default [
  {
    files: ["**/*.{jsx,tsx}"],
    rules: {
      "react/forbid-elements": ["error", {
        forbid: [
          { element: "button", message: "Use the kit Button." },
          { element: "select", message: "Use the kit Select." },
          { element: "textarea", message: "Use the kit Textarea." },
          { element: "dialog", message: "Use the kit Dialog." },
        ],
      }],
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@base-ui/react",
          message: "Import the kit wrapper, not the primitive.",
        }],
        patterns: [{
          group: ["@radix-ui/*", "@base-ui/react/*"],
          message: "Import the kit wrapper, not the primitive.",
        }],
      }],
    },
  },
  {
    files: ["src/components/ui/**"],
    rules: {
      "react/forbid-elements": "off",
      "no-restricted-imports": "off",
    },
  },
];
```

Icon imports are not in this ban. A kit that uses an icon library still expects screens to import icons. Ban an icon package only when the kit re-exports a single Icon component and the project wants that to be the only door.

## 4. stylelint, for real stylesheets and CSS-in-JS

Skip this when the repo has no stylesheets outside the token file.

`no-unknown-custom-properties` is the current Stylelint rule. There is no `custom-property-no-unknown`.
It treats custom properties as known when they are defined in the same file or in `referenceFiles`.
`referenceFiles` is a config property, not a rule option, and the docs mark it experimental.

```js
export default {
  referenceFiles: ["src/app/globals.css"],
  rules: {
    "no-unknown-custom-properties": true,
  },
};
```

A fallback silences the rule: `var(--missing, #fff)` is not a problem for Stylelint. The check script still reports that as a fragile invented token. Do not treat a green Stylelint run as a clean token set.

`stylelint-declaration-strict-value` provides `scale-unlimited/declaration-strict-value`.
The primary option is a property name, a `/regex/`, or a list of those.
`ignoreVariables` defaults to `true`, so `var()` passes.
`ignoreFunctions` defaults to `true`, so `oklch()`, `rgb()`, and `color-mix()` all pass and only hex and bare lengths are caught.
Set `ignoreFunctions: false` to catch function literals too. That also flags `color-mix()` and `clamp()` in components, which is what you want: that math belongs in the token file. Exempt the token file.
`ignoreKeywords` is deprecated. Use `ignoreValues`.

```js
export default {
  plugins: ["stylelint-declaration-strict-value"],
  rules: {
    "scale-unlimited/declaration-strict-value": [
      ["/color$/", "fill", "stroke", "font-size", "border-radius", "box-shadow", "/^padding/", "/^margin/", "gap"],
      {
        ignoreVariables: true,
        ignoreFunctions: false,
        ignoreValues: ["currentColor", "transparent", "inherit", "initial", "unset", "none", "0"],
      },
    ],
  },
  overrides: [
    {
      files: ["src/app/globals.css", "**/tokens.css"],
      rules: { "scale-unlimited/declaration-strict-value": null },
    },
  ],
};
```

## 5. jscpd, for near-duplicate components

jscpd v5 (the Rust binary, also the `jscpd` npm package) has `--fail-on-new-clones`.
v4 does not. The flag alone means zero new clones, and it requires `--baseline`, `--baseline-from-ref`, or `--changed`.

Record the current clones once, then fail on anything new. Existing duplication stays.

```bash
jscpd . --baseline .jscpd-baseline.json --update-baseline
jscpd . --baseline .jscpd-baseline.json --fail-on-new-clones
```

Without a committed baseline file:

```bash
jscpd . --baseline-from-ref origin/main --fail-on-new-clones
```

`--baseline-from-ref` conflicts with `--baseline`.
This catches a second card or button that was copied instead of extracted. It does not clean up the copies already in the tree.

## 6. Agent context, only if it is already there

When `components.json` exists and the project already has a shadcn skill or MCP, use it so the kit's variants are in context.
When `.storybook/` exists and a Storybook MCP is already configured, use it to read the real components.
Do not install either one unasked.
