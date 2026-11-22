import { get, put, del } from '@vercel/blob';

const TTL = 5 * 60_000;

export function blobState(token, projectId) {
  const prefix = 'garmin-drive/' + projectId + '/';
  const options = () => ({ access: 'private', token, abortSignal: AbortSignal.timeout(7000) });
  const read = async name => {
    const result = await get(prefix + name, { ...options(), useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream || !result.blob.etag) throw new Error('state_read');
    return { blob: result.blob, data: await new Response(result.stream).json() };
  };
  const save = (name, data, previous) => put(prefix + name, JSON.stringify(data), {
    ...options(), contentType: 'application/json', addRandomSuffix: false,
    allowOverwrite: Boolean(previous), ...(previous ? { ifMatch: previous.blob.etag } : {}),
  });
  return {
    async lock() {
      const previous = await read('lock.json');
      if (previous?.data.expiresAt > Date.now()) return null;
      try {
        const lock = await save('lock.json', { expiresAt: Date.now() + TTL }, previous);
        return () => del(lock.url, { token, ifMatch: lock.etag, abortSignal: AbortSignal.timeout(7000) });
      } catch (error) {
        if (error?.name === 'BlobPreconditionFailedError' || /already exists/i.test(error?.message ?? '')) return null;
        throw error;
      }
    },
    async id(date, reserve) {
      const name = 'ids/' + date + '.json';
      const existing = await read(name);
      if (existing) {
        const id = existing.data?.id;
        if (!/^[\w-]+$/.test(id ?? '')) throw new Error('state_id_invalid');
        return id;
      }
      const id = await reserve();
      await save(name, { id });
      return id;
    },
  };
}
