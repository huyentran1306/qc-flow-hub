#!/bin/bash
# Bấm đúp để mở QA Flow Hub. Đóng cửa sổ Terminal này để tắt.
cd "$(dirname "$0")" || exit 1
./runtime/node launcher.mjs
