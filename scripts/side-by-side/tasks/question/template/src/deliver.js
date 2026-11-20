const { DeliveryError } = require('./errors.js');

/** One delivery: calls send(url, body) and turns a non-2xx answer or a timeout into a DeliveryError. */
async function deliver(send, event, { timeoutMs }) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeliveryError('timed out', { code: 'ETIMEDOUT' })), timeoutMs);
  });
  try {
    const res = await Promise.race([send(event.url, event.body), timeout]);
    if (res.status < 200 || res.status > 299) throw new DeliveryError(`status ${res.status}`, { status: res.status });
    return res;
  } catch (err) {
    if (err instanceof DeliveryError) throw err;
    throw new DeliveryError(err.message, { code: err.code ?? null });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { deliver };
