#!/bin/bash
# 1.20.73: a `//` comment pasted in the middle of a string-concatenation chain swallows the rest of the line (the `+` or the
# next argument) — it passed `node --check` three times (1.20.13, 1.20.66, 1.20.67) and broke a page at runtime. Refuse any
# line in the page scripts that ends a `//` comment with a dangling operator or opens a bracket it never closes.
bad=0
for f in "$@"; do
  # code, then a // comment, then a dangling + or && at the very end: the operator belonged to the code
  while IFS= read -r line; do echo "!!! $f: a // comment ends in an operator (it swallowed code): ${line:0:120}"; bad=1; done < <(grep -nE "^[^/]*[^[:space:]/][^/]*//[^\"']*(\+|&&|\|\|)\s*$" "$f" | grep -vE "https?://" )
done
exit $bad
