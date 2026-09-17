package main

import (
	"regexp"

	"github.com/microcosm-cc/bluemonday"
)

// Canonical pad-content allowlist. Mirrored in exactly two other places —
// keep all three in sync when changing this list:
//   - server/services/sanitizeHtml.js  (sanitize-html config, Node server)
//   - standalone/public/js/upload.js   (DOMPurify config, client-side paste)
//   - public/js/upload.js              (same, root tree copy)
//
// This is the actual security boundary: pad content is broadcast to every
// live viewer via a WS "changed" -> GET /api/pad refetch (see
// standalone/ws.go), so an unsanitized PUT here would XSS everyone who has
// the pad open.
var padHTMLPolicy = buildPadHTMLPolicy()

// Whitelist-by-construction: each regexp only matches a narrow safe form,
// so url(), expression(), javascript: etc. can never match and are dropped.
var (
	styleTextAlign      = regexp.MustCompile(`^(?:left|right|center|justify)$`)
	styleVerticalAlign  = regexp.MustCompile(`^(?:top|middle|bottom|baseline)$`)
	styleBackgroundHex  = regexp.MustCompile(`^#[0-9a-fA-F]{3,8}$`)
	styleBackgroundRGB  = regexp.MustCompile(`^rgba?\([\d\s,.%]+\)$`)
	styleBackgroundName = regexp.MustCompile(`^[a-zA-Z]{3,20}$`)
	styleWidth          = regexp.MustCompile(`^\d{1,4}(?:px|%)$`)
)

func buildPadHTMLPolicy() *bluemonday.Policy {
	p := bluemonday.NewPolicy()

	p.AllowElements(
		"table", "thead", "tbody", "tfoot", "tr", "td", "th",
		"p", "br", "div", "span",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"strong", "b", "em", "i", "u", "s",
		"ul", "ol", "li", "a", "blockquote", "code", "pre",
	)

	p.AllowAttrs("colspan", "rowspan").OnElements("td", "th")
	p.AllowAttrs("href").OnElements("a")
	p.AllowStandardURLs() // http/https (+ relative) only, strips javascript:/data:
	p.RequireNoFollowOnLinks(true)
	p.AddTargetBlankToFullyQualifiedLinks(true)

	// style: allowed on every element in the allowlist above, but only the
	// 4 declarations below, each value-validated by regexp.
	p.AllowAttrs("style").Matching(regexp.MustCompile(`^[a-zA-Z0-9;:.,%#()\s-]*$`)).Globally()

	// No img/video/script/style(tag)/iframe/object/embed/form/svg/etc. —
	// not in AllowElements, so bluemonday strips them (and, for
	// script/style, their contents) by default.

	return p
}

// sanitizeHTML strips the incoming HTML down to the canonical pad-content
// allowlist, then re-filters any surviving `style` attribute down to the 4
// allowed CSS declarations (bluemonday's attribute Matching() only
// validates the whole attribute value as one regexp, it can't parse
// individual declarations, so that pass happens here).
func sanitizeHTML(html string) string {
	clean := padHTMLPolicy.Sanitize(html)
	return filterStyleAttributes(clean)
}

var styleAttrRe = regexp.MustCompile(`style="([^"]*)"`)
var styleDeclRe = regexp.MustCompile(`([a-zA-Z-]+)\s*:\s*([^;]+)`)

func filterStyleAttributes(html string) string {
	return styleAttrRe.ReplaceAllStringFunc(html, func(match string) string {
		sub := styleAttrRe.FindStringSubmatch(match)
		if sub == nil {
			return ""
		}
		filtered := filterStyleDeclarations(sub[1])
		if filtered == "" {
			return ""
		}
		return `style="` + filtered + `"`
	})
}

func filterStyleDeclarations(style string) string {
	var kept []string
	for _, m := range styleDeclRe.FindAllStringSubmatch(style, -1) {
		prop := m[1]
		val := m[2]
		// trim surrounding whitespace without importing strings just for this
		for len(val) > 0 && (val[0] == ' ' || val[0] == '\t') {
			val = val[1:]
		}
		for len(val) > 0 && (val[len(val)-1] == ' ' || val[len(val)-1] == '\t') {
			val = val[:len(val)-1]
		}
		switch prop {
		case "text-align":
			if styleTextAlign.MatchString(val) {
				kept = append(kept, prop+": "+val)
			}
		case "vertical-align":
			if styleVerticalAlign.MatchString(val) {
				kept = append(kept, prop+": "+val)
			}
		case "background-color":
			if styleBackgroundHex.MatchString(val) || styleBackgroundRGB.MatchString(val) || styleBackgroundName.MatchString(val) {
				kept = append(kept, prop+": "+val)
			}
		case "width":
			if styleWidth.MatchString(val) {
				kept = append(kept, prop+": "+val)
			}
		}
	}
	out := ""
	for i, decl := range kept {
		if i > 0 {
			out += "; "
		}
		out += decl
	}
	return out
}
