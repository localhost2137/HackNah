// Test keys and thumbprints of claude-plugin/docs/TEST_VECTORS.md. Never use them for anything real.

type PrivateJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string }

export const DEVICE_JWK: PrivateJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'ZrgXnDoNhTdpPghp2Il6zDXnD03mYf0B5FKrCeFT_HQ',
  y: 'yaKxBIJVzGvANrVer415sm8NT8HUIb0fRRD6FqoBizE',
  d: 's8XlTO_ZmbBBhI-gAdYRypKDYuAi1DYzNkaFO2j9Lac',
}
export const PLATFORM_JWK: PrivateJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'rGpHJgL539MWeSaWJnOghDqOMR1QvZdFypmEb6u9UNY',
  y: 'CkUanViEc4u6jplQ4dq-C2DrdJvx76u0ykqEVmBKI54',
  d: 'oUF3ZWAc_NjI9Oex-9n6CBE2SLtAGygPB3KsVm2zK0o',
}

export const DEVICE_JKT = 'IHZQxAD02kLoA9xDzcr3_4c0nNkvXqNvowLWkwaxJu8'
export const PLATFORM_JKT = 'BPzX6_O2ypw283CZiDbj02iaYIJhEv9iVT_3F9F0154'
