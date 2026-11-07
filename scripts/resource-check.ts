import assert from 'node:assert/strict'
import { resourceActivity } from '../src/lib/resourceActivity'
import type { ResponseRecord } from '../src/sim/types'

type Track = ResponseRecord['tracks'][number]
const base: [number, number] = [36.9, 28.2]
const site: [number, number] = [36.85, 28.25]
const track: Track = { id: 'test', name: 'Test arazöz', kind: 'crew', base, availableFromStep: 2,
  points: [{ step: 0, lat: base[0], lon: base[1], status: 'unavailable' },
    { step: 2, lat: base[0], lon: base[1], status: 'idle' },
    { step: 3, lat: site[0], lon: site[1], status: 'enroute' },
    { step: 6, lat: site[0], lon: site[1], status: 'attacking' },
    { step: 10, lat: site[0], lon: site[1], status: 'enroute' },
    { step: 14, lat: base[0], lon: base[1], status: 'idle' }],
  moves: [{ fromStep: 2, toStep: 6, path: [base, site], purpose: 'dispatch' },
    { fromStep: 10, toStep: 14, path: [site, base], purpose: 'return' }] }

assert.equal(resourceActivity(track, 0).remainingMin, 20, 'Known availability must be visible before future samples exist')
assert.equal(resourceActivity({ ...track, points: [] }, 0).remainingMin, 20)
assert.equal(resourceActivity(track, 3.5).remainingMin, 25, 'A T+35 minute playhead must not be rounded down to T+30')
assert.equal(resourceActivity(track, 3.5).label, 'Olay yerine intikal', 'Rewinding must not show the later return trip')
assert.equal(resourceActivity(track, 11).label, 'İstasyona dönüyor')
assert.equal(resourceActivity(track, 11).remainingMin, 30)
assert.equal(resourceActivity(track, 6).remainingMin, null, 'At arrival there is no fictitious remaining journey')
assert.equal(resourceActivity(track, 14).value, 'Hazır')
assert.equal(resourceActivity(track, 14).progress, null, 'No percentage is invented for an idle resource')
assert.equal(resourceActivity(track, 13.99).remainingMin, 1, 'A journey under way cannot show zero minutes')

const patrol: Track = { ...track, moves: [{ fromStep: 2, toStep: 12, arrivalStep: 5, purpose: 'patrol', path: [base, site] }] }
assert.equal(resourceActivity(patrol, 3).remainingMin, 20, 'Arrival at the patrol area differs from completion of the route')
assert.equal(resourceActivity(patrol, 6).caption, 'rota sonuna')

const air: Track = { ...track, kind: 'heli', points: [{ step: 2, lat: site[0], lon: site[1], status: 'dropping' }],
  moves: [{ fromStep: 2, toStep: 3, path: [site, base], purpose: 'water' },
    { fromStep: 3, toStep: 4, path: [base, base], purpose: 'refill' },
    { fromStep: 4, toStep: 5, path: [base, site], purpose: 'drop' }] }
assert.equal(resourceActivity(air, 2.5).label, 'Su kaynağına uçuş')
assert.equal(resourceActivity(air, 3.5).label, 'Su ikmali yapılıyor', 'A stationary refill leg still has a known completion time')
assert.equal(resourceActivity(air, 3.5).remainingMin, 5)
assert.equal(resourceActivity(air, 4.5).caption, 'varışa')
assert.equal(resourceActivity({ ...air, points: [{ step: 3, lat: base[0], lon: base[1], status: 'grounded' }] }, 3.5).remainingMin, null,
  'Night grounding must suppress an interrupted flight countdown')

const redirected: Track = { ...track, moves: [...track.moves, { fromStep: 3, toStep: 5, path: [site, base], purpose: 'return' }] }
assert.equal(resourceActivity(redirected, 3.5).label, 'İstasyona dönüyor', 'The latest order replaces an older overlapping journey')
assert.equal(resourceActivity(redirected, 5.5).remainingMin, null, 'A replaced route must not resume when the new one finishes')
console.log('Araç UI kapısı geçildi: hazırlık, varış, dönüş, geri sarma, devriye, su ikmali ve kesilen görevler.')
