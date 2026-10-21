#!/usr/bin/env python3
"""Resolve additive merge conflicts by keeping both sides (ours, then theirs).

When `ours` ends inside an object (more `{`/`(` opened than closed), the shared
closing text after the conflict belongs to it, so the object is closed before
`theirs`: `});` for a top-level statement (router routes), `},\n  {` for an array
element (nav items).
"""
import re
import sys

BLOCK = re.compile(r"<<<<<<< [^\n]*\n(.*?)(?:\|\|\|\|\|\|\| [^\n]*\n.*?)?=======\n(.*?)>>>>>>> [^\n]*\n", re.S)


def balance(text: str) -> int:
    return text.count("{") + text.count("(") - text.count("}") - text.count(")")


def merge(m: re.Match) -> str:
    ours, theirs = m.group(1), m.group(2)
    if not ours.strip() or not theirs.strip():
        return ours + theirs
    key = re.compile(r"\s*(\w+):")
    ko, kt = key.match(ours), key.match(theirs)
    if balance(ours) <= 0 and ko and kt and ko.group(1) == kt.group(1) and balance(theirs) == 0:
        # Two property lists of sibling array elements: close one, open the next.
        indent = re.match(r"\s*", theirs).group(0)
        outer = indent[:-2] if len(indent) >= 2 else ""
        return ours + f"{outer}}},\n{outer}{{\n" + theirs
    if balance(ours) <= 0:
        return ours + theirs
    first = theirs.lstrip()
    if first.startswith(("const ", "//", "export ", "function ")):
        return ours + "});\n\n" + theirs
    indent = re.match(r"\s*", theirs).group(0)
    outer = indent[:-2] if len(indent) >= 2 else ""
    return ours + f"{outer}}},\n{outer}{{\n" + theirs


for path in sys.argv[1:]:
    text = open(path).read()
    text = BLOCK.sub(merge, text)
    open(path, "w").write(text)
    left = text.count("<<<<<<<")
    print(f"{path}: markers left {left}")
