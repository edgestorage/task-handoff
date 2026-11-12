use desktop_streaming::{
    annexb::{from_avcc, from_avcc_for},
    codec::VideoCodec,
};
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

#[test]
fn hevc_keyframes_repeat_vps_sps_pps_and_detect_irap_nals() {
    let parameters = vec![
        vec![0x40, 0x01, 0xaa],
        vec![0x42, 0x01, 0xbb],
        vec![0x44, 0x01, 0xcc],
    ];
    let mut data = vec![0, 0, 0, 3, 0x26, 0x01, 0xdd];
    let (out, keyframe) = from_avcc_for(&data, 4, &parameters, VideoCodec::H265).unwrap();
    assert!(keyframe);
    assert_eq!(
        out,
        vec![
            0, 0, 0, 1, 0x40, 0x01, 0xaa, 0, 0, 0, 1, 0x42, 0x01, 0xbb, 0, 0, 0, 1, 0x44, 0x01,
            0xcc, 0, 0, 0, 1, 0x26, 0x01, 0xdd,
        ]
    );

    data = vec![0, 0, 0, 3, 0x02, 0x01, 0xee];
    assert_eq!(
        from_avcc_for(&data, 4, &parameters, VideoCodec::H265).unwrap(),
        (vec![0, 0, 0, 1, 0x02, 0x01, 0xee], false)
    );
    assert!(from_avcc_for(&data, 0, &parameters, VideoCodec::H265).is_err());
    assert!(from_avcc_for(
        &[0, 0, 0, 2, 0x26, 0x01],
        4,
        &parameters[..2],
        VideoCodec::H265
    )
    .is_err());
}
