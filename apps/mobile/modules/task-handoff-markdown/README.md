# Task Handoff Markdown

Apple-only local Expo module for rendering an entire Markdown response as one
non-scrolling, selectable TextKit 2 `UITextView`. Android and environments without the
native module continue to use `SafeMarkdown`'s JavaScript renderer.

The module uses Foundation's Markdown parser and converts its presentation
intents into one `NSAttributedString`. Streaming reveal and the short text fade
run from a native `CADisplayLink`, so React does not rebuild a tree of Markdown
nodes for each character.

Code, Mermaid, tables, and rules reserve layout space through attachments, then
host native views positioned from TextKit 2 layout fragments. This avoids the
TextKit attachment-provider install behavior that leaves custom views detached
on current iOS releases. Code uses HighlighterSwift to produce attributed text
inside a native selectable, horizontally scrolling view with copy support.
`mermaid` fences use BeautifulMermaidSwift for native Core Graphics rendering.
The Expo config plugin pins and links these Swift packages into the generated app
target; no WebView participates in either rendering path.

`SafeMarkdown`'s React Native renderer is the visual baseline. The native path
uses the same body and heading metrics, spacing, theme colors, code-block
geometry, quote treatment, horizontal table layout, borders, header fill, and
striped rows. UIKit fonts are scaled with Dynamic Type while retaining those
baseline proportions.
