document.addEventListener('click', event => {
  const element = event.target;
  if (element.tagName === 'BUTTON') {
    webviewApi.postMessage({
      data: element.dataset,
    });
  }
});
