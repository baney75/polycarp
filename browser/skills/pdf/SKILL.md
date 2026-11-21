---
name: pdf
description: Extract the text of a PDF and cite where each claim is. Says so plainly when a PDF is a scan with no text layer. Use when the user wants to read a PDF, go through a PDF, pull numbers out of a PDF, find something in a PDF, get a table out of a PDF, ask what a PDF says, or says a PDF comes back empty or is scanned.
license: AGPL-3.0
---

# pdf: read a PDF, cite the page

`get_page_text` on a tab showing a PDF returns the PDF's own text, marked page by page:
`--- Page 7 of 15 ---`. Cite the page from those markers. Never write a page number
you did not see in a marker.

## When to use

- The user gives a PDF link, or a tab shows a PDF.
- The user wants a summary, a quote, numbers from a table, or one section of a PDF.
- A PDF "comes back empty" and the user wants to know why.

For a web page or article, use `summarize`. For a polished report or page as output, use
the `artifacts` skill.

## Steps

1. **Open it.** `tabs_context {}`, then `navigate {"url":"<pdf url>"}`. Don't download it
   or open files on the user's computer unless they ask.
2. **Read the text.** `get_page_text {}`. The result has `pdf.pages`, the page count.
   - A long PDF: read the first pages, then the pages you need, with
     `get_page_text {"pages":"10-14"}`. `pdf.truncated: true` means it was cut: read the rest by range.
   - A PDF in an embedded viewer on a normal page: open the PDF's own address first.
3. **Check for a text layer.** If `pdf.note` says the PDF has no text layer, it is a scan or
   images of pages. Tell the user that, then read the pages you need with `screenshot {}`.
   Say those parts come from reading images and could not be checked against text.
   If the note names some pages only, treat just those pages that way.
4. **Find the part you need.** Search the text for the heading or word. Use the nearest
   `--- Page N of M ---` above it as the page.
5. **Printed page numbers.** A paper's printed numbers can differ from the PDF's own
   ("p. 7 of 15" vs a printed "143"). Cite the PDF's page. Add the printed one only if you saw it.
6. **Tables.** The text keeps cells in reading order, one row per line in most PDFs. Rebuild
   the table and check each number against the text. If the columns don't line up, take a
   `screenshot {}` of that page to read them, and say so.
7. **Summarize section by section.** One short paragraph per section, each with its pages:
   "Methods (pp. 4–6): ...". Quote only words you copied, in quotation marks, with the page.
8. **Close up.** `tabs_close` your tab.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| "Only PDFs on the web can be read this way" | The PDF is a local file. Ask the user for a web address, or read the pages with `screenshot {}` and say so. |
| "The PDF answered 401" or 403 | It needs a sign-in. Call `tabs_show {}` and ask the user to sign in, then read again. |
| The text is symbols or broken letters | The PDF's fonts hide the text. Read the pages you need with `screenshot {}` and say so. |
| "over the 60 MB this reads" | Read the pages you need with `screenshot {}`, or ask for a smaller copy. |
| A page shows "(no text layer on this page)" | That page is an image. Read it with `screenshot {}`. |

## Done when

- Every claim has a page from a `--- Page N ---` marker, or says it came from a page image.
- A scanned PDF was called a scan only because `pdf.note` said so.
- Your tab is closed.

## Example

The user asks: "What does this annual report say about revenue? https://example.org/ar-2025.pdf"

```
navigate {"url":"https://example.org/ar-2025.pdf"}
get_page_text {}                -> pdf.pages 48, truncated, first 12 pages of text
get_page_text {"pages":"20-24"} -> "--- Page 21 of 48 --- ... Revenue rose 8% to $4.2 billion ..."
```

Answer: "Revenue rose 8% to $4.2 billion (p. 21). The report credits the services segment (p. 22)."
Tab closed.
