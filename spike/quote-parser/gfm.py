"""GitHub's own parser, cmark-gfm, through the cmarkgfm binding.

Reads a JSON array of bodies on stdin and writes, for each body, the
0-based lines that render inside a blockquote. GitHub's extensions and footnotes are on
and raw HTML is omitted, as GitHub renders a comment. A line counts as
quoted when it lies inside a blockquote's source range, or inside the
range of any block in one.
"""
import json
import sys
from html.parser import HTMLParser

import cmarkgfm
from cmarkgfm.cmark import Options


class Quotes(HTMLParser):
    VOID = {"hr", "br", "img", "input"}

    def __init__(self):
        super().__init__()
        self.stack = []
        self.lines = set()

    def handle_starttag(self, tag, attrs):
        pos = dict(attrs).get("data-sourcepos")
        inside = tag == "blockquote" or any(t == "blockquote" for t, _ in self.stack)
        if pos and inside:
            start, end = pos.split("-")
            for n in range(int(start.split(":")[0]), int(end.split(":")[0]) + 1):
                self.lines.add(n - 1)
        if tag not in self.VOID:
            self.stack.append((tag, pos))

    def handle_endtag(self, tag):
        while self.stack:
            if self.stack.pop()[0] == tag:
                break


def quoted(body):
    html = cmarkgfm.github_flavored_markdown_to_html(body, options=Options.CMARK_OPT_SOURCEPOS | Options.CMARK_OPT_FOOTNOTES)
    parser = Quotes()
    parser.feed(html)
    return sorted(parser.lines)


print(json.dumps([quoted(b) for b in json.load(sys.stdin)]))
