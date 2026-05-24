import { describe, it, expect } from 'vitest'
import type { Memory } from '../src/types.js'

describe('Memory interface - project field', () => {
  it('allows Memory object without project field', () => {
    const memory: Memory = {
      id: 'mem_123',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      type: 'pattern',
      title: 'Test Memory',
      content: 'This is test content',
      concepts: ['concept1', 'concept2'],
      files: ['file1.ts'],
      sessionIds: ['ses_123'],
      strength: 0.8,
      version: 1,
      isLatest: true,
    }
    expect(memory.project).toBeUndefined()
  })

  it('allows Memory object with project field specified', () => {
    const memory: Memory = {
      id: 'mem_456',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      type: 'preference',
      title: 'Project-specific Memory',
      content: 'This memory belongs to a project',
      concepts: ['proj-concept'],
      files: ['project-file.ts'],
      sessionIds: ['ses_456'],
      project: 'my-project',
      strength: 0.9,
      version: 1,
      isLatest: true,
    }
    expect(memory.project).toBe('my-project')
  })
})
