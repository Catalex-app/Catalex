//! Source coverage for PDF annotations. Inverse search returns one nearby source
//! position, not all the source lines contributing to a typeset line.
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Source {
    pub tag: u32,
    pub line: u32,
}

#[derive(Debug, serde::Serialize)]
pub struct SourceBox {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub sources: Vec<Source>,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct SourceMap {
    pub inputs: HashMap<u32, String>,
    pub boxes: Vec<SourceBox>,
}

pub fn parse_source_map(data: &str) -> SourceMap {
    let mut map = SourceMap::default();
    let mut magnification = 1000.0;
    let mut unit = 1.0;
    let mut x_offset = 0.0;
    let mut y_offset = 0.0;
    let mut page = 0;
    let mut content = false;
    let mut last_v = 0.0;
    // An invalid box still occupies a stack slot, so its closing record cannot
    // accidentally pop a valid parent. Vertical boxes isolate their children.
    let mut stack: Vec<Option<usize>> = Vec::new();
    let mut forms = Vec::new();
    for record in data.lines().map(str::trim) {
        if let Some(input) = record.strip_prefix("Input:") {
            if let Some((tag, file)) = input.split_once(':') {
                if let Ok(tag) = tag.parse() {
                    map.inputs.insert(tag, file.to_owned());
                }
            }
            continue;
        }
        if !content {
            if let Some(v) = record.strip_prefix("Magnification:") {
                magnification = v.trim().parse().unwrap_or(1000.0);
            } else if let Some(v) = record.strip_prefix("Unit:") {
                unit = v.trim().parse().unwrap_or(1.0);
            } else if let Some(v) = record.strip_prefix("X Offset:") {
                x_offset = v.trim().parse().unwrap_or(0.0);
            } else if let Some(v) = record.strip_prefix("Y Offset:") {
                y_offset = v.trim().parse().unwrap_or(0.0);
            } else if record == "Content:" {
                content = true;
            }
            continue;
        }
        if record.starts_with("Postamble:") {
            break;
        }
        let Some(kind) = record.as_bytes().first().copied() else {
            continue;
        };
        if kind == b'{' {
            page = record[1..].parse().unwrap_or(0);
            stack.clear();
            continue;
        }
        // Form definitions have their own coordinate space. Skip their boxes,
        // but restore the enclosing sheet instead of losing the rest of its text.
        if kind == b'<' {
            forms.push((page, std::mem::take(&mut stack)));
            page = 0;
            continue;
        }
        if kind == b'>' {
            if let Some((saved_page, saved_stack)) = forms.pop() {
                page = saved_page;
                stack = saved_stack;
            }
            continue;
        }
        if kind == b'}' {
            page = 0;
            stack.clear();
            continue;
        }
        if kind == b')' || kind == b']' {
            stack.pop();
            continue;
        }
        if !b"[(hvxgk$".contains(&kind) {
            continue;
        }
        let mut fields = record[1..].split(':');
        let source = fields.next().and_then(|field| {
            let mut parts = field.split(',');
            Some(Source {
                tag: parts.next()?.parse().ok()?,
                line: parts.next()?.parse().ok()?,
            })
        });
        let point = fields.next().and_then(|field| {
            let (h, v) = field.split_once(',')?;
            let h: f64 = h.parse().ok()?;
            let v = if v == "=" { last_v } else { v.parse().ok()? };
            last_v = v;
            Some((h, v))
        });
        if kind == b'[' {
            stack.push(None);
            continue;
        }
        if kind == b'(' {
            let dimensions = fields.next().and_then(|field| {
                let mut parts = field.split(',');
                Some((
                    parts.next()?.parse::<f64>().ok()?,
                    parts.next()?.parse::<f64>().ok()?,
                    parts.next()?.parse::<f64>().ok()?,
                ))
            });
            let index = match (source, point, dimensions) {
                (Some(source), Some((h, v)), Some((w, height, depth))) if page > 0 => {
                    let factor = unit * magnification / (1000.0 * 65536.0) * 72.0 / 72.27;
                    let index = map.boxes.len();
                    map.boxes.push(SourceBox {
                        page,
                        x: (h + x_offset + w.min(0.0)) * factor,
                        y: (v + y_offset - height) * factor,
                        width: w.abs() * factor,
                        height: (height + depth).max(0.0) * factor,
                        sources: vec![source],
                    });
                    Some(index)
                }
                _ => None,
            };
            stack.push(index);
        } else if let (Some(source), Some(Some(index))) = (source, stack.last()) {
            let sources = &mut map.boxes[*index].sources;
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    map.boxes.retain(|b| b.width > 0.0 && b.height > 0.0);
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_fixture_matches_native_source_map() {
        let map = parse_source_map(include_str!(
            "../../src/renderer/dev/fixtures/pdf-comments/multipage.synctex"
        ));
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/renderer/dev/fixtures/pdf-comments/multipage-map.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(map).unwrap(), expected);
    }

    #[test]
    fn reads_late_inputs_compressed_coordinates_and_nested_boxes() {
        let data = "Input:1:./main.tex\nUnit:65536\nContent:\n{1\n(1,9:100,100:200,10,2\nx1,3:110,=\n(1,4:120,=:20,10,2\nx1,4:130,=\n)\nx1,5:160,=\n)\n}1\nInput:2:./chapter.tex\n{2\n(2,7:100,200:200,10,2\nx2,6:110,=\n)\n}2\nPostamble:\n";
        let map = parse_source_map(data);
        assert_eq!(map.inputs.get(&2).unwrap(), "./chapter.tex");
        assert_eq!(map.boxes.len(), 3);
        assert!(map.boxes[0].sources.contains(&Source { tag: 1, line: 3 }));
        assert!(map.boxes[0].sources.contains(&Source { tag: 1, line: 5 }));
        assert!(!map.boxes[1].sources.contains(&Source { tag: 1, line: 5 }));
        assert!((map.boxes[1].y - 90.0 * 72.0 / 72.27).abs() < 0.001);
        assert_eq!(map.boxes[2].page, 2);
        assert!(map.boxes[2].sources.contains(&Source { tag: 2, line: 6 }));
    }

    #[test]
    fn embedded_form_does_not_discard_remaining_sheet_text() {
        let map = parse_source_map("Input:1:./main.tex\nContent:\n{2\n<1\n(1,2:0,0:200,10,0\nx1,2:100,0\n)\n>\n(1,4:0,200:200,10,0\nx1,3:100,200\n)\n}2\nPostamble:\n");
        assert_eq!(map.boxes.len(), 1);
        assert_eq!(map.boxes[0].page, 2);
        assert!(map.boxes[0].sources.contains(&Source { tag: 1, line: 3 }));
    }

    #[test]
    fn wrapped_source_line_keeps_coverage_on_every_page() {
        let map = parse_source_map(include_str!(
            "../../src/renderer/dev/fixtures/pdf-comments/multipage.synctex"
        ));
        // Real pdfTeX output: source line 6 wraps over two PDF lines. The old
        // inverse lookup at their centers returns source lines 5 and 7 instead.
        for baseline in [134.765, 146.720] {
            assert!(
                map.boxes.iter().any(|b| b.page == 2
                    && b.y <= baseline
                    && b.y + b.height >= baseline
                    && b.sources.contains(&Source { tag: 1, line: 6 })),
                "missing source line 6 at PDF page 2, y={baseline}"
            );
        }
        for (page, line) in [(1, 3), (3, 10)] {
            assert!(map
                .boxes
                .iter()
                .any(|b| b.page == page && b.sources.contains(&Source { tag: 1, line })));
        }
        assert_eq!(
            map.inputs.get(&1).map(String::as_str),
            Some("./multipage.tex")
        );
    }
}
