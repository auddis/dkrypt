use crate::error::ClientError;
const HEADER_SIZE: usize = 76;
const NAME_SIZE_OFFSET: usize = 59;
const FILE_SIZE_OFFSET: usize = 65;
const MAGIC: &[u8; 6] = b"070707";
const TRAILER: &str = "TRAILER!!!";
#[derive(Debug)]
pub struct Entry {
    pub name: String,
    pub body: Vec<u8>,
}
#[derive(Debug)]
pub enum Step {
    Entry(Entry),
    End,
    NeedMore(usize),
}
pub fn next_entry(
    buffer: &mut Vec<u8>,
    keep: impl FnOnce(&str) -> bool,
) -> Result<Step, ClientError> {
    if buffer.len() < HEADER_SIZE {
        return Ok(Step::NeedMore(HEADER_SIZE - buffer.len()));
    }
    if &buffer[..MAGIC.len()] != MAGIC {
        return Err(ClientError::Sap(format!(
            "invalid CPIO magic {:?}",
            String::from_utf8_lossy(&buffer[..MAGIC.len()])
        )));
    }
    let name_size = parse_octal(&buffer[NAME_SIZE_OFFSET..FILE_SIZE_OFFSET])? as usize;
    let file_size = parse_octal(&buffer[FILE_SIZE_OFFSET..HEADER_SIZE])? as usize;
    if name_size < 1 {
        return Err(ClientError::Sap("CPIO name size is zero".into()));
    }
    let total = HEADER_SIZE + name_size + file_size;
    if buffer.len() < total {
        return Ok(Step::NeedMore(total - buffer.len()));
    }
    let name_bytes = &buffer[HEADER_SIZE..HEADER_SIZE + name_size];
    if name_bytes[name_size - 1] != 0 {
        return Err(ClientError::Sap("CPIO name is not NUL-terminated".into()));
    }
    let name = String::from_utf8_lossy(&name_bytes[..name_size - 1]).into_owned();
    if name == TRAILER {
        buffer.drain(..total);
        return Ok(Step::End);
    }
    let body = if keep(&name) {
        buffer[HEADER_SIZE + name_size..total].to_vec()
    } else {
        Vec::new()
    };
    buffer.drain(..total);
    Ok(Step::Entry(Entry { name, body }))
}
fn parse_octal(value: &[u8]) -> Result<u64, ClientError> {
    let text = std::str::from_utf8(value)
        .map_err(|_| ClientError::Sap("CPIO field is not ASCII".into()))?;
    u64::from_str_radix(text.trim(), 8)
        .map_err(|e| ClientError::Sap(format!("parse CPIO octal value {text:?}: {e}")))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn header(name: &str, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&b"0".repeat(NAME_SIZE_OFFSET - MAGIC.len()));
        out.extend_from_slice(format!("{:06o}", name.len() + 1).as_bytes());
        out.extend_from_slice(format!("{:011o}", body.len()).as_bytes());
        out.extend_from_slice(name.as_bytes());
        out.push(0);
        out.extend_from_slice(body);
        out
    }
    #[test]
    fn decodes_entry_and_keeps_wanted_body() {
        let mut buffer = header("./a", b"hello");
        let Step::Entry(entry) = next_entry(&mut buffer, |_| true).unwrap() else {
            panic!("expected an entry");
        };
        assert_eq!(entry.name, "./a");
        assert_eq!(entry.body, b"hello");
        assert!(buffer.is_empty());
    }
    #[test]
    fn discards_unwanted_body_but_still_consumes_it() {
        let mut buffer = header("./big", &vec![7u8; 4096]);
        let Step::Entry(entry) = next_entry(&mut buffer, |_| false).unwrap() else {
            panic!("expected an entry");
        };
        assert_eq!(entry.name, "./big");
        assert!(entry.body.is_empty());
        assert!(buffer.is_empty());
    }
    #[test]
    fn reports_how_much_more_input_is_needed() {
        let full = header("./a", b"hello");
        let mut buffer = full[..HEADER_SIZE + 2].to_vec();
        let Step::NeedMore(needed) = next_entry(&mut buffer, |_| true).unwrap() else {
            panic!("expected a request for more input");
        };
        assert_eq!(needed, full.len() - buffer.len());
        assert_eq!(buffer.len(), HEADER_SIZE + 2);
    }
    #[test]
    fn stops_at_trailer() {
        let mut buffer = header(TRAILER, b"");
        assert!(matches!(
            next_entry(&mut buffer, |_| true).unwrap(),
            Step::End
        ));
    }
    #[test]
    fn rejects_foreign_magic() {
        let mut buffer = vec![b'x'; HEADER_SIZE];
        assert!(next_entry(&mut buffer, |_| true).is_err());
    }
}
