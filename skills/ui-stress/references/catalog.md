# Worst-case catalog

Load values in phase 2, the failure-signature table in phase 4, and the appendix in phase 6.
Use the rows that match the field map.
Each value is something a real user could produce.
If the schema max is shorter, use the schema max instead.

Counts, widths, and row limits in this file are placeholders.
Bind them to the project's schema, breakpoints, and list bounds.
Use `example.com`, `example.org`, or `.test` for emails and URLs.
The fixture must not point at a real inbox or site.

Styling fixes use the project's tokens and kit.
Overflow fixes follow `css-craft`.
Hardcoded colors found in dark mode are a `ui-consistency` finding.

## People and names

| Value | Breaks |
| --- | --- |
| `Aleksandra Wiśniewska-Kowalczyk` | Long, hyphenated, with diacritics. Wraps to two lines, and the hyphen is a break point |
| `Christopher Alexander Montgomery III` | Long, with a suffix. Naive first-and-last initials come out as `CI` |
| `Konstantin Oberhauser-Wettstein` | Long and compound. Overflows a single-line row |
| `Jo` | Two letters. The name column looks empty. One initial is the correct result, not a bug |
| `J` | One letter. One initial is correct. The hit target is tiny if the name is the link |
| `Ólafur Darri Ólafsson` | Leading accented capital. Uppercase and sort logic, initials `ÓÓ` if both words are kept |
| `Đặng Thị Ngọc Hân` | Stacked Vietnamese diacritics. Clipped by a tight `line-height` plus overflow clipping |
| `王秀英` | CJK, no spaces. First-and-last-word logic finds one word. CJK can break anywhere |
| `نور الهدى عبد الرحمن` | RTL. Punctuation and icons land on the wrong side without `dir="auto"` |
| `Seán O'Brien-Ó Súilleabháin` | Apostrophe and accents. Escaping, initials, and search |
| `María José de la Cruz y Fernández` | Lowercase particles. Naive initials come out as `Md` or `MF`. Family-name order is a Decision, not a first-and-last bug |
| `dana` | All lowercase. Initials should still be uppercase |
| `🦊 Fox` | Emoji first. `.charAt(0)` returns half a surrogate pair |
| `👩🏽‍💻 Priya` | ZWJ emoji sequence. `.length` is more than 2, and slicing splits the emoji |
| `  Sam   Lee ` | Leading, trailing, and repeated spaces. Initials from empty words, odd gaps |
| missing | No name, only an email. The UI needs a fallback |

## Emails, URLs, identifiers

Unbreakable strings have no spaces, so the browser has nowhere to wrap them.

| Value | Breaks |
| --- | --- |
| `bartholomew.fitzgerald@northwind-industries-holdings.example.com` | Pushes every sibling off the row without a wrap rule on the email |
| `a@b.co` | Shortest realistic email. A layout that assumed a long email looks empty |
| `first.last+billing-notifications@example.com` | Plus-addressing. Validation that rejects `+`, or truncation that hides the local part |
| `ops@sub.department.region.example.co.uk` | Many subdomains and a two-part TLD. Domain-extraction logic |
| `https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved` | Long URL. Overflow, and end truncation hides the part that differs |
| `9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f` | UUID. Monospace width. Candidate for middle truncation |
| `Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf` | File name. End truncation hides the version and the extension. Brackets and dashes in the name |
| `IMG_20250914_183022_HDR_portrait_edited_edited.HEIC` | Camera file name. Unbreakable, uppercase extension |
| `@a` / `@thisisaverylongusernamethatisallowed` | Handle extremes |

## Labels, titles, and copy from data

| Value | Breaks |
| --- | --- |
| `Senior Product Design Engineer, Platform Infrastructure` | Long job title. Wraps to three lines in a secondary slot |
| `Invitation expired 12 days ago` | Long status badge. The badge wraps, or it squeezes the name column |
| `Benachrichtigungseinstellungen` | German compound, no spaces. Label overflow |
| `Paramètres de confidentialité et de sécurité` | French expansion of a short English label. Translated UI copy runs long |
| Twelve tags on one item | The tag row becomes a wall. It needs a `+N` overflow |
| `customer-feedback-from-enterprise-onboarding` | One tag wider than its container |
| `Untitled` / empty string / whitespace only | Missing title. Collapsed heading, or a zero-height row |
| `<script>alert(1)</script>` / `&amp;` / `**bold**` | Must render as literal text |
| A newline inside a single-line field | Doubles the row height, or the newline is dropped with no sign |
| A 2,000-character pasted description, or the schema max if that is shorter | Clamp, show-more, and textarea growth |

## Numbers and money

| Value | Breaks |
| --- | --- |
| `0` | Zero states. `0 members`, an empty progress bar, division by zero in a percentage |
| `1` | Plurals. `1 members`, `1 days ago` |
| `1284` | Needs a thousands separator |
| `1000000` | Count-badge width. Compact form only where precision does not matter |
| `12345678.9` as currency | A long formatted amount overflows a totals column |
| `-42.5` | Negative sign, and accounting parentheses. Color comes from the project's semantic token, not a raw red |
| `0.1 + 0.2` | A binary float rendered raw |
| `142%` / `-3%` | Progress bars and meters past their bounds |
| `null` / `undefined` / `NaN` | Rendered as those words |
| `1.284` in `de-DE` beside `1,284` in `en-US` | Hardcoded separators are wrong for half the users |
| A live value that goes from `99` to `100` | Width jump without tabular numerals |

## Collections

| Value | Breaks |
| --- | --- |
| 0 items | Whether an empty state exists at all |
| 1 item | A grid that looks broken with one card. `1 of 1` |
| Exactly the page size, and page size + 1 | Off-by-one in `Showing 40 of 40`. An empty page 2 |
| The project's upper bound, or 1,000+ rows if the list is unpaginated and unbounded | Scroll cost, render time, memory, and the `Showing N of M` copy |
| One item about 10 times the size of the others | Masonry and grid rows stretch to the tallest item |
| Items with identical names | A list whose only distinguishing field is the name |

## Time

Use `Intl.RelativeTimeFormat` and `Intl.DateTimeFormat`, not hand-built strings.

| Value | Breaks |
| --- | --- |
| Now | `0 seconds ago` instead of a just-now label |
| 12 days ago, 11 months ago, 3 years ago | Relative-time thresholds. Switch to an absolute date past the project's cutoff. If it has none, switch after about a week |
| A future date | `in 3 days` versus a negative `ago` string |
| `1970-01-01` | A zero timestamp shown as a real date |
| A timestamp near midnight with an offset, such as `2025-12-31T23:30:00-08:00` | A different calendar day in UTC and in the user's zone |
| A long duration, such as 1,284 hours | Formatting that never rolls hours up to days |

## Images and media

| Value | Breaks |
| --- | --- |
| Avatar URL that 404s | A broken-image icon instead of the initials fallback |
| No avatar at all | The fallback itself. Initials, color from a token, size parity with a real avatar |
| A very wide image, such as 4000 by 200, used as an avatar or cover | Distortion without `object-fit: cover` |
| A very tall image, such as 200 by 4000 | Distortion on the other axis, and a card whose height blows out |
| Transparent PNG logo, or a dark logo on a dark background | Invisible on the background |
| A slow image with no reserved box | Layout shift. Fixed dimensions or `aspect-ratio` |

## States

| Value | Breaks |
| --- | --- |
| Loading | A skeleton that does not match the final layout, or a spinner that shifts content |
| Error from the API | No error state, or a raw message such as a `TypeError`. Status-code detail is in the appendix |
| Partial data | Some optional fields filled and others not, in the same list. Rows misalign |
| Every status at once | All enum values in one list. Badge widths vary |
| No permission | Disabled actions. The row should still lay out the same |
| The current user in the list | A you-label, and actions that must not apply to yourself |

## Environment

Not data.
Check these after the worst-case fixture is on screen.

| Condition | Breaks |
| --- | --- |
| The project's narrowest width. If it names none, 320px | Every overflow above, at once |
| Narrow sidebar placement, about 280px if the project has no sidebar width | A component designed full-width, reused in a narrow column |
| The widest layout the component supports. If it names none, 2560px | Lines too long to read, content stranded on one side |
| Browser zoom 200%, or the large-text setting | Fixed heights that clip growing text |
| Dark mode, if the product has it | Hardcoded colors, invisible borders, invisible logos. Point the fix at `ui-consistency`. Do not swap in another literal |
| `dir="rtl"`, if the product supports it | Icons, chevrons, padding, and the order of trailing actions |
| Touch, if the product is used without a pointer | Hover-only actions are unreachable |

## Failure signatures

Load this section in phase 4, before judging.
Match what you see to a row.
The cause column is the usual cause.
If the CSS shows a different cause, name that cause and still give a fix.

| What you see | Cause | Fix |
| --- | --- | --- |
| Avatar or icon squished into an oval or pill | Flex child shrinking | `flex-shrink: 0` on the avatar, icon, and any fixed-size box |
| Text overflows its box | Flex or grid child keeps the default minimum of its content width | `min-inline-size: 0` on the text column. In grid, `minmax(0, 1fr)`. Then wrap or truncate the text |
| Email or URL runs past the edge | No break opportunity in the string | `overflow-wrap: break-word` on that element. Table cells use `anywhere` |
| Trailing action pushed off or clipped | Middle content took the free space | `min-inline-size: 0` on the middle, `flex-shrink: 0` on the action |
| Badge wraps onto two lines | Badge was allowed to shrink | `white-space: nowrap` and `flex-shrink: 0` on the badge. Decide what yields |
| Avatar looks adrift beside a three-line name | `align-items: center` on rows of varying height | `align-items: start` once text can wrap |
| Last row cut off mid-glyph | Fixed height, no scroll or fade | A visible scrollbar or a fade, and an overflow value chosen on purpose |
| A heading breaks mid-word | `word-break: break-all` | `overflow-wrap: break-word` |
| Wrong initials, or a replacement character | `.charAt(0)`, `.split(' ')[0][0]`, or first-and-last word that keeps a suffix | `Intl.Segmenter` graphemes. Trim, collapse spaces, skip suffixes and particles, then the first letter of the first remaining word and of the last. One word gets one initial. A non-letter grapheme gets a fallback icon |
| Name column looks empty | Value is `Jo` or `J` | One initial is correct. Do not pad. Check alignment and the hit size |
| Orphaned dash or a blank line where the role was | A placeholder rendered for a missing optional field | Omit the line, or reserve its height on purpose |
| `1 members` or `0 member` | English plural written as a suffix check | `Intl.PluralRules`, or one string per count from the project's i18n |
| Numbers jitter, or columns of figures misalign | Proportional figures | The project's numeric text style, or `font-variant-numeric: tabular-nums` if it has none |
| `1284`, a long float, `NaN`, or `undefined` on screen | Raw number rendered | `Intl.NumberFormat` for the user's locale. Guard null, undefined, and NaN |
| Translated button label overflows | Fixed `width` on the button | Width from the label, with a `min-width` from the project's scale |
| Diacritics or tall scripts clipped | Tight `line-height` plus clipping | A looser line-height, or no clipping on the text box |
| Broken-image icon in the avatar | No error fallback | Initials fallback. `object-fit: cover` for any aspect ratio |
| Truncated text with no way to read it | Ellipsis and nothing else | The project's tooltip, or a `title`, plus the full value in a detail view |
| Scrolling a huge list stutters | Every row rendered | Paginate or virtualize. The choice goes in Decisions |
| Raw tags, entities, or markdown markers on screen | Escaped at the wrong layer | Escape once, at render. Do not pass user data to `dangerouslySetInnerHTML` |

## Appendix: error, network, and concurrency

Run this after the data checks.
Force the condition through the stub or the interaction.
Do not edit the component to draw the failure.
A banner, a retry button, an empty state, or an inline field error comes from the kit.
Copy color comes from a semantic token.

### Error status

| Condition | How to force it | What breaks | Fix shape |
| --- | --- | --- | --- |
| Field validation, including HTTP 400 | Stub returns field errors | A toast only, or the input is cleared | Errors sit on the fields. Say what to change. Keep what the user typed |
| HTTP 401 | Stub returns 401 | Raw JSON, or a dead screen | Send the user to sign in. Do not show the response body |
| HTTP 403 | Stub returns 403 | A control that fails with no reason | Say what is forbidden. Leave the rest of the screen up |
| HTTP 404 | Stub returns 404 | A blank region | A not-found state with a next step |
| HTTP 429 | Stub returns 429 | Looks like a crash | Say to wait. Do not clear the form |
| HTTP 500 | Stub returns 500 with a stack or a `TypeError` | Exception text on screen | A generic message and a retry. No exception text |
| One region fails | One request fails, siblings succeed | The whole page is replaced by an error | The failed region shows the error. The rest stays |

### Network

| Condition | How to force it | What breaks | Fix shape |
| --- | --- | --- | --- |
| Offline | Disable the network, or hang the stub while the client is offline | A spinner that never ends, or a blank | Say the client is offline. Stop the spinner. Keep the last good data if any |
| Timeout | Hang the stub past the project's timeout | The same message as offline | A timeout is not offline. Offer retry |
| Slow | Delay the stub | Layout jump, unlabeled spinner | The loading state from the States table. Name what is loading |
| Refresh fails | A later fetch fails after a good first paint | The data vanishes | Keep the last good data and mark it stale |
| Retry a write | Activate retry on a failed write | A second record | Retry the same request. The control stays inactive while it runs |

### Concurrency

| Condition | How to force it | What breaks | Fix shape |
| --- | --- | --- | --- |
| Double submit | Activate submit many times, quickly | Several records, or several requests | The control is inactive while the request runs. One activation, one request |
| Out-of-order responses | Start a slow request, then a fast one, and let the slow one finish last | The UI shows the older result | Drop a response older than the latest request for that view |
| Optimistic rollback | Update locally, then reject on the server | The UI keeps the rejected value | Roll back to the server value and show the error |
| Leave mid-request | Navigate away while a request is in flight | A late write, or an update after the view is gone | Abort the request on leave |
| Two editors | Save the same field from two sessions | A silent overwrite | Show that a newer value exists. Do not drop either value without a choice |
