package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Mirrors public/js/metadata/office-clean.js and server/services/officeClean.js:
// same cleaning logic, so all three sides (browser, server, CLI) behave
// identically on a .docx/.xlsx/.pptx.

const emptyCoreXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>`

const emptyAppXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>`

var (
	xmlDeclRe      = regexp.MustCompile(`<\?xml[^>]*\?>`)
	innerContentRe = regexp.MustCompile(`(?s)^<[^>]+>(.*)</[^>]+>$`)
	relTagRe       = regexp.MustCompile(`<Relationship\b[^>]*/>`)
	targetAttrRe   = regexp.MustCompile(`Target="([^"]*)"`)
	overrideTagRe  = regexp.MustCompile(`<Override\b[^>]*/>`)
	partNameAttrRe = regexp.MustCompile(`PartName="([^"]*)"`)
)

// Parts whose Target/PartName must be removed from the relationship files
// and [Content_Types].xml once deleted — avoids Word/Excel/PowerPoint
// prompting to "repair" the file on open.
var removedPartMatchers = []*regexp.Regexp{
	regexp.MustCompile(`customXml/`),
	regexp.MustCompile(`docProps/thumbnail\.`),
	regexp.MustCompile(`docProps/custom\.xml$`),
}

func partHasContent(xmlText string) bool {
	withoutDecl := strings.TrimSpace(xmlDeclRe.ReplaceAllString(xmlText, ""))
	inner := withoutDecl
	if m := innerContentRe.FindStringSubmatch(withoutDecl); m != nil {
		inner = strings.TrimSpace(m[1])
	}
	return len(inner) > 0
}

func matchesAny(target string, matchers []*regexp.Regexp) bool {
	for _, re := range matchers {
		if re.MatchString(target) {
			return true
		}
	}
	return false
}

func stripRelationships(xmlText string) string {
	return relTagRe.ReplaceAllStringFunc(xmlText, func(tag string) string {
		m := targetAttrRe.FindStringSubmatch(tag)
		if m == nil || !matchesAny(m[1], removedPartMatchers) {
			return tag
		}
		return ""
	})
}

func stripContentTypeOverrides(xmlText string) string {
	return overrideTagRe.ReplaceAllStringFunc(xmlText, func(tag string) string {
		m := partNameAttrRe.FindStringSubmatch(tag)
		if m == nil || !matchesAny(m[1], removedPartMatchers) {
			return tag
		}
		return ""
	})
}

// CleanOoxml removes docProps/core.xml and docProps/app.xml (author,
// company, dates…), docProps/custom.xml, the embedded thumbnail, and the
// entire customXml/ folder (Custom XML Parts — where enterprise
// classification/DLP tools like Titus or Microsoft Purview store tags
// outside the usual Office properties). Returns the cleaned document and a
// human-readable list of what was found and removed.
func CleanOoxml(data []byte) ([]byte, []string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, fmt.Errorf("invalid or corrupted Office file")
	}

	parts := make(map[string][]byte, len(zr.File))
	order := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return nil, nil, fmt.Errorf("failed to read %q: %w", f.Name, err)
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("failed to read %q: %w", f.Name, err)
		}
		parts[f.Name] = content
		order = append(order, f.Name)
	}

	var removed []string
	touchedAnyPart := false

	if content, ok := parts["docProps/core.xml"]; ok {
		if partHasContent(string(content)) {
			removed = append(removed, "Core properties (author, title, creation/edit dates) — docProps/core.xml")
		}
		parts["docProps/core.xml"] = []byte(emptyCoreXML)
		touchedAnyPart = true
	}
	if content, ok := parts["docProps/app.xml"]; ok {
		if partHasContent(string(content)) {
			removed = append(removed, "Application properties (company, manager, editing time) — docProps/app.xml")
		}
		parts["docProps/app.xml"] = []byte(emptyAppXML)
		touchedAnyPart = true
	}

	customXmlCount := 0
	hasCustomProps := false
	hasThumbnail := false
	deleted := make(map[string]bool)
	for _, name := range order {
		switch {
		case strings.HasPrefix(name, "customXml/"):
			customXmlCount++
			deleted[name] = true
			touchedAnyPart = true
		case name == "docProps/custom.xml":
			hasCustomProps = true
			deleted[name] = true
			touchedAnyPart = true
		case strings.HasPrefix(name, "docProps/thumbnail."):
			hasThumbnail = true
			deleted[name] = true
			touchedAnyPart = true
		}
	}
	if hasCustomProps {
		removed = append(removed, "Custom properties — docProps/custom.xml")
	}
	if hasThumbnail {
		removed = append(removed, "Thumbnail embedded in the document")
	}
	if customXmlCount > 0 {
		removed = append(removed, fmt.Sprintf("Custom XML Parts — classification/DLP tags (%d file(s))", customXmlCount))
	}
	for name := range deleted {
		delete(parts, name)
	}
	kept := order[:0]
	for _, name := range order {
		if !deleted[name] {
			kept = append(kept, name)
		}
	}
	order = kept

	for _, name := range order {
		if !strings.HasSuffix(name, ".rels") {
			continue
		}
		original := string(parts[name])
		if cleaned := stripRelationships(original); cleaned != original {
			parts[name] = []byte(cleaned)
		}
	}
	if content, ok := parts["[Content_Types].xml"]; ok {
		original := string(content)
		if cleaned := stripContentTypeOverrides(original); cleaned != original {
			parts["[Content_Types].xml"] = []byte(cleaned)
		}
	}

	if !touchedAnyPart {
		return nil, nil, fmt.Errorf("this file doesn't look like a valid Office OOXML document")
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range order {
		w, err := zw.Create(name)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to rebuild the document: %w", err)
		}
		if _, err := w.Write(parts[name]); err != nil {
			return nil, nil, fmt.Errorf("failed to rebuild the document: %w", err)
		}
	}
	if err := zw.Close(); err != nil {
		return nil, nil, fmt.Errorf("failed to rebuild the document: %w", err)
	}

	return buf.Bytes(), removed, nil
}
