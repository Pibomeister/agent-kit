export async function requestWithRetry(request) {
  let calls = 0;
  while (calls < 2) {
    calls += 1;
    const response = await request();
    if (response.status < 500 && response.status !== 400) return { response, calls };
  }
  return { response: { status: 400 }, calls };
}
