use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use crate::gpu::lock;

pub fn image_data(data: peniko::Blob<u8>, width: u32, height: u32) -> peniko::ImageData {
    peniko::ImageData { data, format: peniko::ImageFormat::Rgba8, alpha_type: peniko::ImageAlphaType::Alpha, width, height }
}

#[derive(Default)]
pub struct ImageSet(Mutex<HashMap<u64, Weak<GpuImage>>>);

impl ImageSet {
    pub fn find(&self, id: u64) -> Option<Arc<GpuImage>> {
        lock(&self.0).get(&id)?.upgrade()
    }

    pub fn lookup(&self, image: &peniko::ImageData) -> Option<Arc<GpuImage>> {
        self.find(image.data.id())
    }

    pub fn is_empty(&self) -> bool {
        lock(&self.0).is_empty()
    }
}

pub struct GpuImage {
    pub texture: wgpu::Texture,
    id: u64,
    set: Weak<ImageSet>,
    generation: AtomicU64,
    copied: AtomicU64,
}

impl AsRef<[u8]> for GpuImage {
    fn as_ref(&self) -> &[u8] {
        &[]
    }
}

impl GpuImage {
    pub fn new(texture: wgpu::Texture, set: &Arc<ImageSet>) -> Arc<Self> {
        let id = peniko::Blob::<u8>::new(Arc::new(Vec::<u8>::new())).id();
        let image = Arc::new(Self { texture, id, set: Arc::downgrade(set), generation: AtomicU64::new(0), copied: AtomicU64::new(0) });
        lock(&set.0).insert(id, Arc::downgrade(&image));
        image
    }

    pub fn image(self: &Arc<Self>) -> peniko::ImageData {
        image_data(peniko::Blob::from_raw_parts(self.clone(), self.id), self.texture.width(), self.texture.height())
    }

    pub fn brush(self: &Arc<Self>) -> peniko::ImageBrush {
        peniko::ImageBrush { image: self.image(), sampler: peniko::ImageSampler::default() }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn painted(&self) {
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn copied(&self) -> bool {
        self.copied.load(Ordering::Acquire) >= self.generation()
    }

    pub fn mark_copied(&self, generation: u64) {
        self.copied.fetch_max(generation, Ordering::Release);
    }
}

impl Drop for GpuImage {
    fn drop(&mut self) {
        if let Some(set) = self.set.upgrade() {
            lock(&set.0).remove(&self.id);
        }
    }
}
