#![allow(clippy::needless_range_loop)]

use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::Arc;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, Decoder, DecoderOptions};
use symphonia::core::errors::Error;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use super::graph::{AudioData, Bus, QUANTUM, hermite};

struct Opened {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track: u32,
    rate: f64,
    channels: usize,
    duration: Option<f64>,
}

fn open(bytes: Arc<[u8]>) -> Result<Opened, String> {
    let source = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let probed = symphonia::default::get_probe()
        .format(&Hint::new(), source, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .map_err(|e| format!("unsupported audio: {e}"))?;
    let format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or("no audio track")?;
    let params = &track.codec_params;
    let decoder = symphonia::default::get_codecs().make(params, &DecoderOptions::default()).map_err(|e| format!("unsupported codec: {e}"))?;
    let rate = params.sample_rate.ok_or("no sample rate")? as f64;
    let channels = params.channels.map_or(0, |c| c.count());
    let duration = match (params.n_frames, params.time_base) {
        (Some(n), Some(base)) => {
            let t = base.calc_time(n);
            Some(t.seconds as f64 + t.frac)
        }
        (Some(n), None) => Some(n as f64 / rate),
        _ => None,
    };
    let track = track.id;
    Ok(Opened { format, decoder, track, rate, channels, duration })
}

fn next(o: &mut Opened, out: &mut Vec<f32>, channels: &mut usize) -> Result<bool, String> {
    loop {
        let packet = match o.format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
            Err(Error::ResetRequired) => {
                o.decoder.reset();
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != o.track {
            continue;
        }
        match o.decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                *channels = spec.channels.count();
                let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buffer.copy_interleaved_ref(decoded);
                out.clear();
                out.extend_from_slice(buffer.samples());
                return Ok(true);
            }
            Err(Error::DecodeError(_)) | Err(Error::IoError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
}

pub fn decode_all(bytes: Arc<[u8]>, rate: f64) -> Result<AudioData, String> {
    let mut o = open(bytes)?;
    let mut channels = o.channels.max(1);
    let mut planar: Vec<Vec<f32>> = Vec::new();
    let mut packet = Vec::new();
    while next(&mut o, &mut packet, &mut channels)? {
        if planar.len() < channels {
            let len = planar.first().map_or(0, Vec::len);
            planar.resize_with(channels, || vec![0.0; len]);
        }
        for frame in packet.chunks_exact(channels) {
            for (c, v) in frame.iter().enumerate() {
                planar[c].push(*v);
            }
        }
    }
    if planar.is_empty() || planar[0].is_empty() {
        return Err("no audio in the data".into());
    }
    if (o.rate - rate).abs() > 0.5 {
        for channel in &mut planar {
            *channel = resample(channel, o.rate, rate);
        }
    }
    Ok(AudioData { rate, channels: planar })
}

pub fn resample(samples: &[f32], from: f64, to: f64) -> Vec<f32> {
    let n = samples.len();
    if n == 0 {
        return Vec::new();
    }
    let len = ((n as f64) * to / from).round().max(1.0) as usize;
    let at = |i: isize| samples[i.clamp(0, n as isize - 1) as usize];
    let step = from / to;
    (0..len)
        .map(|k| {
            let x = k as f64 * step;
            let i = x.floor() as isize;
            hermite(at(i - 1), at(i), at(i + 1), at(i + 2), (x - i as f64) as f32)
        })
        .collect()
}

pub struct MediaStream {
    bytes: Arc<[u8]>,
    o: Opened,
    pub rate: f64,
    pub channels: usize,
    pub duration: f64,
    queue: VecDeque<[f32; 2]>,
    frac: f64,
    base: f64,
    played: u64,
    skip: u64,
    eof: bool,
    pad: usize,
    packet: Vec<f32>,
}

impl MediaStream {
    pub fn open(bytes: Arc<[u8]>) -> Result<MediaStream, String> {
        let o = open(bytes.clone())?;
        let duration = match o.duration {
            Some(d) => d,
            None => scan_duration(bytes.clone()).unwrap_or(f64::NAN),
        };
        let (rate, channels) = (o.rate, o.channels);
        let mut stream = MediaStream { bytes, o, rate, channels, duration, queue: VecDeque::new(), frac: 0.0, base: 0.0, played: 0, skip: 0, eof: false, pad: 0, packet: Vec::new() };
        stream.reset_queue();
        Ok(stream)
    }

    fn reset_queue(&mut self) {
        self.queue.clear();
        self.queue.push_back([0.0; 2]);
        self.frac = 0.0;
        self.played = 0;
        self.eof = false;
        self.pad = 0;
    }

    pub fn time(&self) -> f64 {
        self.base + (self.played as f64 + self.frac) / self.rate
    }

    pub fn seek(&mut self, seconds: f64) {
        let seconds = if self.duration.is_finite() { seconds.clamp(0.0, self.duration) } else { seconds.max(0.0) };
        self.reset_queue();
        self.skip = 0;
        let to = SeekTo::Time { time: Time::from(seconds), track_id: Some(self.o.track) };
        match self.o.format.seek(SeekMode::Accurate, to) {
            Ok(seeked) => {
                self.o.decoder.reset();
                let track = self.o.format.tracks().iter().find(|t| t.id == self.o.track);
                let base = track.and_then(|t| t.codec_params.time_base);
                let secs = |ts: u64| base.map_or(ts as f64 / self.rate, |b| {
                    let t = b.calc_time(ts);
                    t.seconds as f64 + t.frac
                });
                let (actual, required) = (secs(seeked.actual_ts), secs(seeked.required_ts));
                self.skip = ((required - actual).max(0.0) * self.rate).round() as u64;
                self.base = actual;
            }
            Err(_) => {
                if let Ok(o) = open(self.bytes.clone()) {
                    self.o = o;
                }
                self.base = 0.0;
                self.skip = (seconds * self.rate).round() as u64;
            }
        }
    }

    fn fill(&mut self) -> bool {
        while self.queue.len() < 4 {
            if self.eof {
                self.queue.push_back([0.0; 2]);
                self.pad += 1;
                continue;
            }
            let mut channels = self.channels.max(1);
            let mut packet = std::mem::take(&mut self.packet);
            match next(&mut self.o, &mut packet, &mut channels) {
                Ok(true) => {
                    self.channels = channels;
                    for frame in packet.chunks_exact(channels) {
                        if self.skip > 0 {
                            self.skip -= 1;
                            self.played += 1;
                            continue;
                        }
                        let right = if channels > 1 { frame[1] } else { frame[0] };
                        self.queue.push_back([frame[0], right]);
                    }
                }
                Ok(false) | Err(_) => self.eof = true,
            }
            self.packet = packet;
        }
        self.queue.len() > self.pad + 1
    }

    pub fn render(&mut self, out: &mut Bus, out_rate: f64, speed: f64, gain: f32, looping: bool) -> bool {
        let step = speed.max(0.0) * self.rate / out_rate;
        for i in 0..QUANTUM {
            if !self.fill() {
                if looping {
                    self.seek(0.0);
                    if !self.fill() {
                        return true;
                    }
                } else {
                    return true;
                }
            }
            let t = self.frac as f32;
            let (a, b, c, d) = (self.queue[0], self.queue[1], self.queue[2], self.queue[3]);
            for ch in 0..2 {
                out[ch][i] += gain * hermite(a[ch], b[ch], c[ch], d[ch], t);
            }
            self.frac += step;
            while self.frac >= 1.0 && self.queue.len() > 2 {
                self.queue.pop_front();
                self.frac -= 1.0;
                self.played += 1;
                if self.queue.len() < 4 && !self.fill() {
                    break;
                }
            }
        }
        false
    }
}

fn scan_duration(bytes: Arc<[u8]>) -> Option<f64> {
    let mut o = open(bytes).ok()?;
    let base = o.format.tracks().iter().find(|t| t.id == o.track)?.codec_params.time_base;
    let mut total: u64 = 0;
    loop {
        match o.format.next_packet() {
            Ok(packet) if packet.track_id() == o.track => total += packet.dur,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    Some(match base {
        Some(b) => {
            let t = b.calc_time(total);
            t.seconds as f64 + t.frac
        }
        None => total as f64 / o.rate,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn wav(rate: u32, channels: u16, freq: f64, seconds: f64) -> Vec<u8> {
        let frames = (rate as f64 * seconds) as u32;
        let data_len = frames * channels as u32 * 2;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let v = ((std::f64::consts::TAU * freq * i as f64 / rate as f64).sin() * 0.5 * 32767.0) as i16;
            for _ in 0..channels {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    fn crossings(samples: &[f32]) -> f64 {
        let ups: Vec<usize> = samples.windows(2).enumerate().filter(|(_, w)| w[0] < 0.0 && w[1] >= 0.0).map(|(i, _)| i).collect();
        (ups.len() - 1) as f64 / (ups[ups.len() - 1] - ups[0]) as f64
    }

    #[test]
    fn decodes_a_wav_and_resamples_it() {
        let bytes: Arc<[u8]> = wav(44100, 2, 441.0, 0.5).into();
        let data = decode_all(bytes, 48000.0).unwrap();
        assert_eq!(data.channels.len(), 2);
        assert_eq!(data.rate, 48000.0);
        assert!((data.len() as f64 - 24000.0).abs() <= 1.0, "{}", data.len());
        let f = crossings(&data.channels[0]) * 48000.0;
        assert!((f - 441.0).abs() < 0.5, "{f}");
        let peak = data.channels[1].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.5).abs() < 0.01, "{peak}");
    }

    #[test]
    fn rejects_what_is_not_audio() {
        assert!(decode_all(Arc::from(&b"<html>not audio</html>"[..]), 48000.0).is_err());
        assert!(MediaStream::open(Arc::from(&b""[..])).is_err());
    }

    #[test]
    fn streams_seeks_and_ends() {
        let bytes: Arc<[u8]> = wav(22050, 1, 220.0, 1.0).into();
        let mut s = MediaStream::open(bytes).unwrap();
        assert!((s.duration - 1.0).abs() < 1e-6, "{}", s.duration);
        let mut samples = Vec::new();
        let mut ended = false;
        while !ended && samples.len() < 60000 {
            let mut out = [[0.0; QUANTUM]; 2];
            ended = s.render(&mut out, 48000.0, 1.0, 1.0, false);
            samples.extend_from_slice(&out[0]);
        }
        assert!(ended);
        assert!((samples.len() as f64 - 48000.0).abs() <= 2.0 * QUANTUM as f64, "{}", samples.len());
        let f = crossings(&samples[..47000]) * 48000.0;
        assert!((f - 220.0).abs() < 0.5, "{f}");

        s.seek(0.5);
        assert!((s.time() - 0.5).abs() < 0.01, "{}", s.time());
        let mut out = [[0.0; QUANTUM]; 2];
        assert!(!s.render(&mut out, 48000.0, 2.0, 1.0, false));
        assert!((s.time() - (0.5 + 2.0 * QUANTUM as f64 / 48000.0)).abs() < 0.01, "{}", s.time());
    }
}
