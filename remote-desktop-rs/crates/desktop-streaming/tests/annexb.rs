use desktop_streaming::annexb::from_avcc;
#[test]
fn every_native_idr_repeats_parameters_and_interframes_preserve_nals() {
    let parameters = vec![vec![0x67, 0x42], vec![0x68, 0x12]];
    for width in [1, 2, 4] {
        let mut data = vec![0; width];
        data[width - 1] = 2;
        data.extend([0x65, 0xaa]);
        let (out, idr) = from_avcc(&data, width, &parameters).unwrap();
        assert!(idr);
        assert_eq!(
            out,
            vec![0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0x12, 0, 0, 0, 1, 0x65, 0xaa]
        );
    }
    assert_eq!(
        from_avcc(&[0, 0, 0, 2, 0x41, 0xab], 4, &[]).unwrap(),
        (vec![0, 0, 0, 1, 0x41, 0xab], false)
    );
}
#[test]
fn malformed_lengths_and_incomplete_idrs_cannot_enter_rtp() {
    for data in [
        &[][..],
        &[0, 0, 0],
        &[0, 0, 0, 0],
        &[0, 0, 0, 4, 0x41],
        &[255, 255, 255, 255],
        &[0, 0, 0, 1, 0xe5],
    ] {
        assert!(from_avcc(data, 4, &[]).is_err());
    }
    assert!(from_avcc(&[0, 0, 0, 1, 0x65], 4, &[]).is_err());
    assert!(from_avcc(&[0, 0, 1, 0x41], 3, &[]).is_err());
}
