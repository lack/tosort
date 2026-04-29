import joplin from 'api';

interface Folder {
  id: string,
  title: string,
}

interface Todo {
  id: string,
  title: string,
  order: number,
}

interface Sorter {
  folder: Folder,
  todos: Todo[],
  panel: any,
}

async function gatherTodos(folder: Folder): Promise<Todo[]> {
  const todos: Todo[] = []
  let page = 1
  let has_more = false
  do {
    const query = await joplin.data.get(
      ['folders', folder.id, 'notes'],
      {
        fields: ['id', 'title', 'is_todo', 'todo_completed', 'order'],
        order_by: 'order',
        order_dir: 'DESC',
        limit: 100,
        page: page++,
      })
    todos.push(...query.items.filter((item: any) =>
      item.todo_completed == 0 &&
      item.is_todo == 1
    ));
    has_more = query.has_more
  } while (has_more)
  return todos
}

function toDiv(todo: Todo): string {
  let result = `
  <div class="todo" id="${todo.id}">
  ☐ ${todo.title}
  <br />
  <button type="button"
    data-id="${todo.id}"
    data-action="top">☶</button>`
  if (todo.order > 0) {
    result += `
  <button type="button"
    data-id="${todo.id}"
    data-action="up">𝌥</button>
  <button type="button"
    data-id="${todo.id}"
    data-action="middle">☵</button>
  <button type="button"
    data-id="${todo.id}"
    data-action="down">𝌫</button>
  <button type="button"
    data-id="${todo.id}"
    data-action="bottom">☳</button>`
  } else {
    result += `
  <button type="button"
    data-id="${todo.id}"
    data-action="middle">☵</button>
  <button type="button"
    data-id="${todo.id}"
    data-action="append">☳</button>`
  }
  result += `
  </div>
  `
  return result
}

async function refreshWebview(sorter: Sorter) {
  const prioritized = sorter.todos.filter((todo: Todo) => todo.order > 0).map(toDiv)
  const unprioritized = sorter.todos.filter((todo: Todo) => todo.order == 0).map(toDiv)
  let html = `
    <h1>${sorter.folder.title}</h1>
    <h2>Prioritized</h2>
    ${prioritized.join('\n')}`
  if (unprioritized.length > 0) {
    html += `
    <h2>Unprioritized</h2>
    ${unprioritized.join('\n')}
    `
  }
  await joplin.views.panels.setHtml(sorter.panel, html);
}

async function updateFolderView(sorter: Sorter) {
  const folder = await joplin.workspace.selectedFolder();
  if (folder.id === sorter.folder.id) {
    return
  }
  sorter.folder = folder

  await joplin.views.panels.setHtml(sorter.panel, `
    <h1>${sorter.folder.title}</h1>
    <div class="loading">Fetching notes...</div>
    `);
  sorter.todos = await gatherTodos(folder);
  await refreshWebview(sorter);
}

interface Ordering {
  min: number,
  max: number,
  count: number,
  step: number,
}

function ordering(sorter: Sorter): Ordering {
  const o: Ordering = {
    min: 0,
    max: 0,
    count: sorter.todos.length,
    step: 5000000,
  }

  const firstUnsortedIdx = sorter.todos.findIndex((t) => t.order === 0);
  if (firstUnsortedIdx > -1) {
    o.count = firstUnsortedIdx;
  }

  o.max = sorter.todos.length === 0 ? -1 : sorter.todos[0].order
  o.min = sorter.todos.reduce((min, val) => val.order > 0 ? Math.min(min, val.order) : min, Infinity);

  if (o.max > -1 && o.min < Infinity && o.count > 1) {
    o.step = (o.max - o.min) / o.count
  }

  return o;
}

async function syncOrder(todo: Todo) {
  const result = await joplin.data.put(
    ['notes', todo.id],
    {
      fields: ['id', 'title', 'is_todo', 'todo_completed', 'order'],
    },
    { order: todo.order },
  )
  console.info("Result", JSON.stringify(result, null, 2))
}

async function moveTodo(sorter: Sorter, id: string, action: string) {
  // Find the TODO that is the target of this move action
  const oldIdx = sorter.todos.findIndex((t) => t.id === id)
  if (oldIdx === -1) {
    console.error("No todo found with id '%s'", id)
    return
  }
  const target = sorter.todos[oldIdx]
  console.info("Moving TODO", action, target.title, target.order)

  // Interrogate the current list for boundaries that matter
  const o = ordering(sorter);

  const firstUnsortedIdx = o.count
  const lastSortedIdx = firstUnsortedIdx >= 1 ? firstUnsortedIdx - 1 : -1;
  const lastIdx = (firstUnsortedIdx >= 0) ? firstUnsortedIdx : sorter.todos.length - 1;
  console.info("Current indices", lastSortedIdx, firstUnsortedIdx, sorter.todos.length)

  console.info("Current bounds", o.min, o.max, o.step)

  // Compute the new position it should land at
  let newIdx = -1
  switch (action) {
    case "top":
      newIdx = 0;
      break;
    case "up":
      if (oldIdx == 0) {
        newIdx = 0;
      } else {
        newIdx = oldIdx - 1;
      }
      break;
    case "down":
      if (oldIdx < lastSortedIdx) {
        newIdx = oldIdx + 1;
      }
      break;
    case "bottom":
      newIdx = lastSortedIdx;
      break;
    case "middle":
      if (o.count == 1) {
        // Middle = append if theres only 1 item
        newIdx = o.count;
      }
      newIdx = Math.floor(o.count / 2);
      break;
    case "append":
      newIdx = o.count;
      break;
    default:
      console.error("Invalid sort action", action)
      return;
  }
  if (oldIdx === newIdx && target.order > 0) {
    // no-op: target is sorted and where it belongs
    console.info("No change needed")
    return;
  }
  console.info("Moving TODO from", oldIdx, "to", newIdx)
  // Reorder the array
  const [element] = sorter.todos.splice(oldIdx, 1)
  sorter.todos.splice(newIdx, 0, element)

  // Reset the target item's order field
  if (newIdx == 0) {
    // Top of list -> Make it greater than the previous maximum (or 5000 if no current maximum)
    sorter.todos[newIdx].order = (o.max > 0) ? o.max + o.step : o.step * 10
    console.info("Ordering to top-of-list:", sorter.todos[newIdx].order, o.max)
  } else if (newIdx == lastIdx) {
    // Bottom of sorted list -> Make it less than the previous minimum (or 5000 if no current minimum)
    const stepDown = (o.min < Infinity) ? o.min - o.step : o.step * 10
    const halfDown = (o.min < Infinity) ? o.min / 2 : o.step
    sorter.todos[newIdx].order = Math.max(stepDown, halfDown)
    console.info("Ordering to bottom-of-list:", o.min, sorter.todos[newIdx].order)
  } else {
    // Somewhere in the middle -> Make it 1/2 way between the previous and next
    const upper = sorter.todos[newIdx - 1].order
    const lower = sorter.todos[newIdx + 1].order
    const midpoint = upper + ((upper - lower) / 2.0)
    sorter.todos[newIdx].order = midpoint
    console.info("Ordering to middle:", lower, sorter.todos[newIdx].order, upper)
  }
  console.info("Setting TODO order to", sorter.todos[newIdx].order)
  await syncOrder(sorter.todos[newIdx]);

  await refreshWebview(sorter);
}

joplin.plugins.register({
  onStart: async function() {
    const panel = await joplin.views.panels.create('panel_1');
    await joplin.views.panels.addScript(panel, './webview.css');
    await joplin.views.panels.addScript(panel, './webview.js');
    await joplin.views.panels.setHtml(panel, '<div class="loading">Loading...</div>');

    const sorter = {
      folder: {
        id: "",
        title: "",
      },
      todos: [],
      panel: panel,
    }

    await updateFolderView(sorter);

    await joplin.workspace.onNoteSelectionChange(() => {
      updateFolderView(sorter);
    })

    await joplin.views.panels.onMessage(panel, (message: any) => {
      moveTodo(sorter, message.data.id, message.data.action)
    })
  },
});
