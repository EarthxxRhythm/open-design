import { describe, expect, it } from 'vitest';
import type { CollabCloudComment } from '@open-design/contracts';

import {
  collabCloudErrorFromVelaFailure,
  createVelaCliCollabClient,
} from '../src/collab/vela-cli-collab-client.js';

describe('Vela CLI collaboration client failures', () => {
  it('preserves a structured terminal HTTP error emitted by the Vela command boundary', async () => {
    const commandFailure = Object.assign(new Error('the message is not a classifier'), {
      stdout: JSON.stringify({ error: { status: 410, code: 'SHARE_STOPPED', message: 'stopped' } }),
    });
    const client = createVelaCliCollabClient({
      run: async () => { throw commandFailure; },
    });

    await expect(client.pushComment('team-1', 'p1', {} as CollabCloudComment)).rejects.toMatchObject({
      name: 'CollabCloudError', status: 410, code: 'SHARE_STOPPED', message: 'stopped',
    });
  });

  it('requires both structured status and code instead of matching failure prose', () => {
    expect(collabCloudErrorFromVelaFailure(Object.assign(new Error('410 SHARE_STOPPED'), {
      stdout: JSON.stringify({ error: { code: 'SHARE_STOPPED' } }),
    }))).toBeNull();
    expect(collabCloudErrorFromVelaFailure(new Error('410 SHARE_STOPPED'))).toBeNull();
  });
});
