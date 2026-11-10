export declare const SHARED_PLACES: readonly ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos']
export type SharedPlace = (typeof SHARED_PLACES)[number]
export type PlaceCapability = `fs.${SharedPlace}`
