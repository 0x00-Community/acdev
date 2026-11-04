use std::io::Write;

const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const NS_TYPES: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_RELS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_S: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const TYPE: &str = "application/vnd.openxmlformats-officedocument.";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BlankKind {
    Docx,
    Xlsx,
    Pptx,
}

impl TryFrom<&str> for BlankKind {
    type Error = ();
    fn try_from(kind: &str) -> Result<Self, ()> {
        match kind {
            "docx" => Ok(Self::Docx),
            "xlsx" => Ok(Self::Xlsx),
            "pptx" => Ok(Self::Pptx),
            _ => Err(()),
        }
    }
}

impl BlankKind {
    pub fn extension(&self) -> &str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
        }
    }
    pub fn default_name(&self) -> &str {
        match self {
            Self::Docx => "未命名文档",
            Self::Xlsx => "未命名表格",
            Self::Pptx => "未命名演示",
        }
    }
}

struct Part {
    name: Vec<u8>,
    data: Vec<u8>,
    packed: Vec<u8>,
    crc: u32,
    offset: u32,
    method: u16,
}

#[derive(Default)]
struct ZipWriter {
    parts: Vec<Part>,
    offset: u32,
}

impl ZipWriter {
    fn add(mut self, name: &str, content: &str) -> Self {
        let data = content.as_bytes().to_vec();
        let mut deflate = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        let deflated = deflate.write_all(&data).and_then(|()| deflate.finish()).unwrap_or_default();
        let method = if !deflated.is_empty() && deflated.len() < data.len() { 8 } else { 0 };
        let packed = if method == 8 { deflated } else { data.clone() };
        let part = Part { name: name.as_bytes().to_vec(), crc: crc32fast::hash(&data), offset: self.offset, method, data, packed };
        self.offset += (30 + part.name.len() + part.packed.len()) as u32;
        self.parts.push(part);
        self
    }

    fn finish(self) -> Vec<u8> {
        let (time, date) = (0u16, (1u16 << 5) | 1);
        let mut out = Vec::new();
        let u16le = |out: &mut Vec<u8>, v: u16| out.extend_from_slice(&v.to_le_bytes());
        let u32le = |out: &mut Vec<u8>, v: u32| out.extend_from_slice(&v.to_le_bytes());
        for part in &self.parts {
            u32le(&mut out, 0x0403_4b50);
            u16le(&mut out, 20);
            u16le(&mut out, 0x0800);
            u16le(&mut out, part.method);
            u16le(&mut out, time);
            u16le(&mut out, date);
            u32le(&mut out, part.crc);
            u32le(&mut out, part.packed.len() as u32);
            u32le(&mut out, part.data.len() as u32);
            u16le(&mut out, part.name.len() as u16);
            u16le(&mut out, 0);
            out.extend_from_slice(&part.name);
            out.extend_from_slice(&part.packed);
        }
        let (start, mut size) = (self.offset, 0u32);
        for part in &self.parts {
            u32le(&mut out, 0x0201_4b50);
            u16le(&mut out, 20);
            u16le(&mut out, 20);
            u16le(&mut out, 0x0800);
            u16le(&mut out, part.method);
            u16le(&mut out, time);
            u16le(&mut out, date);
            u32le(&mut out, part.crc);
            u32le(&mut out, part.packed.len() as u32);
            u32le(&mut out, part.data.len() as u32);
            u16le(&mut out, part.name.len() as u16);
            out.extend_from_slice(&[0; 12]);
            u32le(&mut out, part.offset);
            out.extend_from_slice(&part.name);
            size += 46 + part.name.len() as u32;
        }
        u32le(&mut out, 0x0605_4b50);
        out.extend_from_slice(&[0; 4]);
        u16le(&mut out, self.parts.len() as u16);
        u16le(&mut out, self.parts.len() as u16);
        u32le(&mut out, size);
        u32le(&mut out, start);
        u16le(&mut out, 0);
        out
    }
}

struct Ooxml;

impl Ooxml {
    fn types(overrides: &[(&str, String)]) -> String {
        let overrides: String = overrides.iter().map(|(part, ty)| format!("<Override PartName=\"{part}\" ContentType=\"{ty}\"/>")).collect();
        format!(
            "{XML}<Types xmlns=\"{NS_TYPES}\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>{overrides}</Types>"
        )
    }

    fn rels(items: &[(&str, &str, &str)]) -> String {
        let items: String = items.iter().map(|(id, ty, target)| format!("<Relationship Id=\"{id}\" Type=\"{REL}{ty}\" Target=\"{target}\"/>")).collect();
        format!("{XML}<Relationships xmlns=\"{NS_RELS}\">{items}</Relationships>")
    }

    const TREE: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";

    fn pml() -> String {
        format!("xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\"")
    }

    fn placeholder(id: u32, name: &str, ph: &str, boxed: Option<[u64; 4]>, text: Option<&str>) -> String {
        let xfrm = boxed.map_or_else(String::new, |b| format!("<a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>", b[0], b[1], b[2], b[3]));
        let body = text.map_or_else(
            || "<a:endParaRPr lang=\"zh-CN\" altLang=\"en-US\"/>".to_owned(),
            |t| format!("<a:r><a:rPr lang=\"zh-CN\" altLang=\"en-US\"/><a:t>{t}</a:t></a:r>"),
        );
        format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:spPr>{xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p>{body}</a:p></p:txBody></p:sp>"
        )
    }

    fn solid(color: &str) -> String {
        format!("<a:solidFill><a:schemeClr val=\"{color}\"/></a:solidFill>")
    }

    fn theme() -> String {
        let s = Self::solid("phClr");
        format!(
            "{XML}<a:theme xmlns:a=\"{NS_A}\" name=\"Office\"><a:themeElements><a:clrScheme name=\"Office\"><a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"44546A\"/></a:dk2><a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2><a:accent1><a:srgbClr val=\"4472C4\"/></a:accent1><a:accent2><a:srgbClr val=\"ED7D31\"/></a:accent2><a:accent3><a:srgbClr val=\"A5A5A5\"/></a:accent3><a:accent4><a:srgbClr val=\"FFC000\"/></a:accent4><a:accent5><a:srgbClr val=\"5B9BD5\"/></a:accent5><a:accent6><a:srgbClr val=\"70AD47\"/></a:accent6><a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink><a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Office\"><a:majorFont><a:latin typeface=\"Calibri Light\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont><a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Office\"><a:fillStyleLst>{s}{s}{s}</a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\">{s}</a:ln><a:ln w=\"12700\">{s}</a:ln><a:ln w=\"19050\">{s}</a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>{s}{s}{s}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"
        )
    }
}

impl BlankKind {
    pub fn create(self) -> Vec<u8> {
        match self {
            Self::Docx => Self::docx(),
            Self::Xlsx => Self::xlsx(),
            Self::Pptx => Self::pptx(),
        }
    }

    fn docx() -> Vec<u8> {
        ZipWriter::default()
            .add("[Content_Types].xml", &Ooxml::types(&[("/word/document.xml", format!("{TYPE}wordprocessingml.document.main+xml"))]))
            .add("_rels/.rels", &Ooxml::rels(&[("rId1", "officeDocument", "word/document.xml")]))
            .add(
                "word/document.xml",
                &format!("{XML}<w:document xmlns:w=\"{NS_W}\"><w:body><w:p/><w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1800\" w:bottom=\"1440\" w:left=\"1800\" w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>"),
            )
            .finish()
    }

    fn xlsx() -> Vec<u8> {
        let sheet = format!("{TYPE}spreadsheetml");
        ZipWriter::default()
            .add("[Content_Types].xml", &Ooxml::types(&[
                ("/xl/workbook.xml", format!("{sheet}.sheet.main+xml")),
                ("/xl/worksheets/sheet1.xml", format!("{sheet}.worksheet+xml")),
                ("/xl/styles.xml", format!("{sheet}.styles+xml")),
            ]))
            .add("_rels/.rels", &Ooxml::rels(&[("rId1", "officeDocument", "xl/workbook.xml")]))
            .add("xl/workbook.xml", &format!("{XML}<workbook xmlns=\"{NS_S}\" xmlns:r=\"{NS_R}\"><sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"))
            .add("xl/_rels/workbook.xml.rels", &Ooxml::rels(&[("rId1", "worksheet", "worksheets/sheet1.xml"), ("rId2", "styles", "styles.xml")]))
            .add("xl/worksheets/sheet1.xml", &format!("{XML}<worksheet xmlns=\"{NS_S}\"><sheetData/></worksheet>"))
            .add(
                "xl/styles.xml",
                &format!("{XML}<styleSheet xmlns=\"{NS_S}\"><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>"),
            )
            .finish()
    }

    fn pptx() -> Vec<u8> {
        let pml = format!("{TYPE}presentationml");
        let attrs = Ooxml::pml();
        let (title, subtitle) = ("<p:ph type=\"ctrTitle\"/>", "<p:ph type=\"subTitle\" idx=\"1\"/>");
        let text = |size: u32, color: &str| {
            format!("<a:lvl1pPr><a:defRPr sz=\"{size}\">{}<a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr></a:lvl1pPr>", Ooxml::solid(color))
        };
        let tree = Ooxml::TREE;
        let master = format!(
            "{XML}<p:sldMaster {attrs}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{tree}{}{}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>{}</p:titleStyle><p:bodyStyle>{}</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz=\"1800\"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>",
            Ooxml::placeholder(2, "Title Placeholder 1", "<p:ph type=\"title\"/>", Some([838200, 365125, 10515600, 1325563]), None),
            Ooxml::placeholder(3, "Text Placeholder 2", "<p:ph type=\"body\" idx=\"1\"/>", Some([838200, 1825625, 10515600, 4351338]), None),
            text(4400, "tx1"),
            text(2800, "tx1"),
        );
        let layout = format!(
            "{XML}<p:sldLayout {attrs} type=\"title\" preserve=\"1\"><p:cSld name=\"标题幻灯片\"><p:spTree>{tree}{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
            Ooxml::placeholder(2, "Title 1", title, Some([1524000, 1122363, 9144000, 2387600]), Some("单击此处添加标题")),
            Ooxml::placeholder(3, "Subtitle 2", subtitle, Some([1524000, 3602038, 9144000, 1655762]), Some("单击此处添加副标题")),
        );
        let slide = format!(
            "{XML}<p:sld {attrs}><p:cSld><p:spTree>{tree}{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
            Ooxml::placeholder(2, "Title 1", title, None, None),
            Ooxml::placeholder(3, "Subtitle 2", subtitle, None, None),
        );
        ZipWriter::default()
            .add("[Content_Types].xml", &Ooxml::types(&[
                ("/ppt/presentation.xml", format!("{pml}.presentation.main+xml")),
                ("/ppt/slideMasters/slideMaster1.xml", format!("{pml}.slideMaster+xml")),
                ("/ppt/slideLayouts/slideLayout1.xml", format!("{pml}.slideLayout+xml")),
                ("/ppt/slides/slide1.xml", format!("{pml}.slide+xml")),
                ("/ppt/theme/theme1.xml", format!("{TYPE}theme+xml")),
            ]))
            .add("_rels/.rels", &Ooxml::rels(&[("rId1", "officeDocument", "ppt/presentation.xml")]))
            .add(
                "ppt/presentation.xml",
                &format!("{XML}<p:presentation {attrs}><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/></p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>"),
            )
            .add("ppt/_rels/presentation.xml.rels", &Ooxml::rels(&[("rId1", "slideMaster", "slideMasters/slideMaster1.xml"), ("rId2", "slide", "slides/slide1.xml"), ("rId3", "theme", "theme/theme1.xml")]))
            .add("ppt/slideMasters/slideMaster1.xml", &master)
            .add("ppt/slideMasters/_rels/slideMaster1.xml.rels", &Ooxml::rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "theme", "../theme/theme1.xml")]))
            .add("ppt/slideLayouts/slideLayout1.xml", &layout)
            .add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", &Ooxml::rels(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]))
            .add("ppt/slides/slide1.xml", &slide)
            .add("ppt/slides/_rels/slide1.xml.rels", &Ooxml::rels(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]))
            .add("ppt/theme/theme1.xml", &Ooxml::theme())
            .finish()
    }
}
