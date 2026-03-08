# PDF → Anki

Convert your hand-drawn flashcard PDFs into Anki decks — instantly, in your browser. Nothing is ever uploaded to a server.

**[Try it live →](https://veed0101.github.io/pdf-to-anki/)**

## How it works

1. **Draw on the template** — Open [`template.pdf`](template.pdf) in Samsung Notes, GoodNotes, or any PDF annotation app. Each page holds 2 flashcards side by side:
   - **Top boxes** = front of card
   - **Bottom boxes** = back of card

2. **Export as PDF** — Save your annotated file back to your device.

3. **Convert** — Upload it at the link above, hit *Convert*, and open the downloaded `.apkg` in Anki or AnkiDroid.

## Tech

Pure client-side JavaScript — no backend, no data collection, works offline once loaded.

| Library | Role |
|---------|------|
| [PDF.js](https://mozilla.github.io/pdf.js/) | Renders PDF pages to canvas |
| [sql.js](https://sql.js.org/) | Builds the Anki SQLite database |
| [JSZip](https://stuk.github.io/jszip/) | Packages everything into `.apkg` |

## Local use (Python)

If you prefer to run everything offline on your own machine, the `pdf_to_anki.py` and `generate_template.py` scripts in the parent folder work without a browser.

```bash
pip install PyMuPDF genanki Pillow
python pdf_to_anki.py my_notes.pdf
```

## License

MIT
