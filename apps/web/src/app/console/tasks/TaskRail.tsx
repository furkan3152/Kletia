/** The task list as the left rail (1280 px and up): a labelled region beside the thread. */
import { DESK_COPY } from "../content/copy";
import { TaskList, type TaskListProps } from "./TaskList";

export function TaskRail(props: TaskListProps) {
  return (
    <nav aria-label={DESK_COPY.tasks.listLabel} className="kd-rail">
      <TaskList {...props} headingLevel={2} />
    </nav>
  );
}
