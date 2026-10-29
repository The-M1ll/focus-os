use focus_core::personal::*;

fn put(c: &str, id: &str, j: &str) -> WriteOp {
    WriteOp::Put {
        collection: c.into(),
        id: id.into(),
        json: j.into(),
    }
}

#[test]
fn write_read_update_delete() {
    let s = PersonalStore::open_in_memory().unwrap();
    s.write(&[
        put("notes", "n1", r#"{"t":"hi"}"#),
        put("notes", "n2", r#"{"t":"yo"}"#),
    ])
    .unwrap();
    s.write(&[put("notes", "n1", r#"{"t":"edited"}"#)]).unwrap();
    let all = s.get_all("notes").unwrap();
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|d| d.json.contains("edited")));
    s.write(&[WriteOp::Delete {
        collection: "notes".into(),
        id: "n2".into(),
    }])
    .unwrap();
    assert_eq!(s.get_all("notes").unwrap().len(), 1);
}

#[test]
fn batch_is_atomic() {
    let s = PersonalStore::open_in_memory().unwrap();
    s.write(&[put("a", "1", "{}")]).unwrap();
    let r = s.write(&[put("a", "2", "{}"), put("a", "3", "not json")]);
    assert!(r.is_err());
    assert_eq!(
        s.get_all("a").unwrap().len(),
        1,
        "failed batch must roll back completely"
    );
}

#[test]
fn rejects_bad_names_and_oversize() {
    let s = PersonalStore::open_in_memory().unwrap();
    assert!(s.write(&[put("bad name", "1", "{}")]).is_err());
    assert!(s.write(&[put("a", "../x", "{}")]).is_err());
    let big = format!("\"{}\"", "x".repeat(MAX_DOC_BYTES + 1));
    assert!(s.write(&[put("a", "1", &big)]).is_err());
}

#[test]
fn export_import_roundtrip_and_validation() {
    let s = PersonalStore::open_in_memory().unwrap();
    s.write(&[put("cards", "c1", r#"{"q":"2+2","a":"4"}"#)])
        .unwrap();
    let out = s.export_json().unwrap();
    let t = PersonalStore::open_in_memory().unwrap();
    assert_eq!(t.import_json(&out, true).unwrap(), 1);
    assert_eq!(
        t.get_all("cards").unwrap()[0].json,
        r#"{"q":"2+2","a":"4"}"#
    );

    // A corrupt import must leave existing data untouched.
    assert!(
        t.import_json("{\"format\":\"nope\",\"documents\":[]}", true)
            .is_err()
    );
    assert!(t.import_json("garbage", true).is_err());
    let bad = out.replace("\"collection\":\"cards\"", "\"collection\":\"../../etc\"");
    assert!(t.import_json(&bad, true).is_err());
    assert_eq!(t.get_all("cards").unwrap().len(), 1);
}

#[test]
fn backup_is_verified_and_restorable() {
    let dir = tempfile::tempdir().unwrap();
    let s = PersonalStore::open(&dir.path().join("p.db")).unwrap();
    s.write(&[put("notes", "n", r#"{"t":"keep me"}"#)]).unwrap();
    let dest = dir.path().join("backup.db");
    s.backup_to(&dest).unwrap();
    assert_eq!(PersonalStore::verify_backup(&dest).unwrap(), 1);
    assert!(
        s.backup_to(&dest).is_err(),
        "never overwrite an existing backup"
    );
    // Corrupt file is detected.
    let bad = dir.path().join("bad.db");
    std::fs::write(&bad, b"this is not sqlite").unwrap();
    assert!(PersonalStore::verify_backup(&bad).is_err());
}

#[test]
fn survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("p.db");
    {
        PersonalStore::open(&p)
            .unwrap()
            .write(&[put("t", "1", r#"{"x":1}"#)])
            .unwrap();
    }
    assert_eq!(
        PersonalStore::open(&p).unwrap().get_all("t").unwrap().len(),
        1
    );
}
