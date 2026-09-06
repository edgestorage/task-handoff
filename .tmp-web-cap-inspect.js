export default async function () {
  const resources = performance.getEntriesByType("resource")
    .map((entry) => ({ name: entry.name, start: entry.startTime, duration: entry.duration }))
    .filter((entry) => entry.name.includes("timeline"));
  return {
    ok: true,
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 8000),
    timelineResources: resources.slice(-100),
  };
}
