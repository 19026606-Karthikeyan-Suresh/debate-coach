/**
 * Which environment values count as a project.
 *
 * The important case is the negative one: absent has to come back as null, because that is what
 * a fresh clone looks like and every entry point to sync branches on it.
 */

import { describe, expect, it } from 'vitest'

import { parseSupabaseConfig } from '../config.ts'

describe('parseSupabaseConfig', () => {
  it('accepts a project URL and key', () => {
    expect(parseSupabaseConfig('https://abcdefgh.supabase.co', 'anon-key')).toEqual({
      url: 'https://abcdefgh.supabase.co',
      anonKey: 'anon-key',
    })
  })

  it('treats a missing half as no project rather than half a project', () => {
    expect(parseSupabaseConfig(undefined, 'anon-key')).toBeNull()
    expect(parseSupabaseConfig('https://abcdefgh.supabase.co', undefined)).toBeNull()
    expect(parseSupabaseConfig(undefined, undefined)).toBeNull()
  })

  it('treats an empty `.env` line as absent', () => {
    // `VITE_SUPABASE_ANON_KEY=` produces this, and it is far commoner than a wrong key.
    expect(parseSupabaseConfig('https://abcdefgh.supabase.co', '   ')).toBeNull()
    expect(parseSupabaseConfig('  ', 'anon-key')).toBeNull()
  })

  it('rejects a URL that is not one', () => {
    // supabase-js accepts this at construction and fails on the first request, minutes later.
    expect(parseSupabaseConfig('abcdefgh.supabase.co', 'anon-key')).toBeNull()
    expect(parseSupabaseConfig('not a url at all', 'anon-key')).toBeNull()
  })

  it('refuses plaintext to a real project', () => {
    // The session token would go over the wire in clear.
    expect(parseSupabaseConfig('http://abcdefgh.supabase.co', 'anon-key')).toBeNull()
  })

  it('allows plaintext to a local instance', () => {
    // `supabase start` serves http on 54321 and there is no other way to develop against it.
    expect(parseSupabaseConfig('http://localhost:54321', 'anon-key')?.url).toBe(
      'http://localhost:54321',
    )
    expect(parseSupabaseConfig('http://127.0.0.1:54321', 'anon-key')).not.toBeNull()
  })

  it('strips a trailing slash', () => {
    // supabase-js concatenates paths onto this, and two slashes is a 404 on some routes.
    expect(parseSupabaseConfig('https://abcdefgh.supabase.co/', 'anon-key')?.url).toBe(
      'https://abcdefgh.supabase.co',
    )
  })

  it('trims whitespace a copy-paste leaves behind', () => {
    expect(parseSupabaseConfig(' https://abcdefgh.supabase.co ', ' anon-key ')).toEqual({
      url: 'https://abcdefgh.supabase.co',
      anonKey: 'anon-key',
    })
  })
})
