//! Chromium's data pack, version 5: a table of (id, offset) pairs, aliases, then the resources end to end.
//! Only the text packs in each language folder are read and written; `resources.pak` is left alone.

const VERSION: u32 = 5;
const UTF8: u32 = 1;
const HEADER: usize = 12;
const ENTRY: usize = 6;
const ALIAS: usize = 4;

#[derive(Debug, PartialEq)]
pub struct Pak {
    /// Pairs of (id, index into `entries`), kept as they are: the entries keep their order.
    aliases: Vec<u8>,
    pub entries: Vec<(u16, Vec<u8>)>,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

impl Pak {
    /// None when it is not a version 5 UTF-8 pack, or any part of it points outside the file.
    pub fn parse(b: &[u8]) -> Option<Pak> {
        if u32_at(b, 0)? != VERSION || u32_at(b, 4)? != UTF8 {
            return None;
        }
        let count = u16_at(b, 8)? as usize;
        let table = HEADER + ENTRY * (count + 1);
        let data = table + ALIAS * u16_at(b, 10)? as usize;
        let aliases = b.get(table..data)?.to_vec();
        let mut entries = Vec::with_capacity(count);
        let mut next = data;
        for i in 0..count {
            let at = HEADER + ENTRY * i;
            let start = u32_at(b, at + 2)? as usize;
            let end = u32_at(b, at + ENTRY + 2)? as usize;
            if start != next {
                return None;
            }
            entries.push((u16_at(b, at)?, b.get(start..end)?.to_vec()));
            next = end;
        }
        (next == b.len()).then_some(Pak { aliases, entries })
    }

    pub fn bytes(&self) -> Option<Vec<u8>> {
        let count = u16::try_from(self.entries.len()).ok()?;
        let aliases = u16::try_from(self.aliases.len() / ALIAS).ok()?;
        let mut out = Vec::new();
        out.extend(VERSION.to_le_bytes());
        out.extend(UTF8.to_le_bytes());
        out.extend(count.to_le_bytes());
        out.extend(aliases.to_le_bytes());
        let mut at = HEADER + ENTRY * (self.entries.len() + 1) + self.aliases.len();
        let end = (0u16, Vec::new());
        for (id, bytes) in self.entries.iter().chain([&end]) {
            out.extend(id.to_le_bytes());
            out.extend(u32::try_from(at).ok()?.to_le_bytes());
            at += bytes.len();
        }
        out.extend(&self.aliases);
        for (_, bytes) in &self.entries {
            out.extend(bytes);
        }
        Some(out)
    }
}

#[cfg(test)]
pub fn made_up(texts: &[(u16, &str)]) -> Vec<u8> {
    let entries = texts.iter().map(|(id, t)| (*id, t.as_bytes().to_vec()));
    let pak = Pak {
        aliases: vec![9, 0, 1, 0],
        entries: entries.collect(),
    };
    pak.bytes().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_comes_back_byte_for_byte() {
        let bytes = made_up(&[(1, "one"), (2, ""), (300, "About Helium")]);
        let pak = Pak::parse(&bytes).unwrap();
        assert_eq!(pak.entries.len(), 3);
        assert_eq!(pak.entries[2], (300, b"About Helium".to_vec()));
        assert_eq!(pak.bytes().unwrap(), bytes);
    }

    /// The bytes themselves, so a reader and a writer that are wrong the same way don't agree.
    #[test]
    fn the_layout_is_chromiums() {
        let want = [
            5u8, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, // version, UTF-8, one resource, one alias
            7, 0, 28, 0, 0, 0, // id 7 at 28
            0, 0, 30, 0, 0, 0, // the end
            9, 0, 1, 0, // the alias
            b'h', b'i',
        ];
        assert_eq!(made_up(&[(7, "hi")]), want);
    }

    #[test]
    fn a_pack_that_is_off_is_not_read() {
        let good = made_up(&[(1, "one"), (2, "two")]);
        let mut version = good.clone();
        version[0] = 4;
        let mut utf16 = good.clone();
        utf16[4] = 2;
        let mut offset = good.clone();
        offset[14] = 0xff;
        let mut count = good.clone();
        count[8] = 0xff;
        let mut long = good.clone();
        long.push(0);
        let short = &good[..good.len() - 1];
        // A byte between the table and the first resource, with every offset moved to match.
        let mut gap = good.clone();
        gap.insert(34, 0);
        for at in [14, 20, 26] {
            gap[at] += 1;
        }
        for bad in [&version, &utf16, &offset, &count, &long, &gap] {
            assert_eq!(Pak::parse(bad), None);
        }
        assert_eq!(Pak::parse(short), None);
        assert_eq!(Pak::parse(b""), None);
    }
}
