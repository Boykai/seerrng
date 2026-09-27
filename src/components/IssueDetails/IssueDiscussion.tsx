import Button from '@app/components/Common/Button';
import IssueAffectedEpisodes from '@app/components/IssueDetails/IssueAffectedEpisodes';
import IssueComment from '@app/components/IssueDetails/IssueComment';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import { IssueStatus, MAX_ISSUE_MESSAGE_LENGTH } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import type Issue from '@server/entity/Issue';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useId, useState } from 'react';
import { FormattedDate, useIntl } from 'react-intl';
import ReactMarkdown from 'react-markdown';
import * as Yup from 'yup';

const messages = defineMessages('components.IssueDiscussion', {
  description: 'Description',
  comments: 'Comments',
  noComments: 'No Comments',
  addComment: 'Add Comment',
  commentPlaceholder: 'Add a comment...',
  addHelp: 'Add this comment to the issue without leaving Manage.',
  close: 'Close Issue',
  reopen: 'Reopen Issue',
  closeHelp:
    'Mark this issue as closed. Keep its description, comments and history.',
  reopenHelp:
    'Reopen this closed issue so it can be addressed again. Keep its comments and history.',
  required: 'Enter a comment before adding it.',
  tooLong: 'Comment must be {maxLength, number} characters or fewer.',
  failed: 'Unable to save this change. Please try again.',
  saved: 'Changes saved.',
});

const IssueDiscussion = ({
  issue,
  onUpdate,
}: {
  issue: Issue;
  onUpdate: () => Promise<unknown>;
}) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { addToast } = useToasts();
  const [statusBusy, setStatusBusy] = useState(false);
  const inputId = useId();
  const canComment =
    hasPermission(Permission.MANAGE_ISSUES) || issue.createdBy.id === user?.id;
  const [description, ...comments] = issue.comments ?? [];
  const isOpen = issue.status === IssueStatus.OPEN;
  const schema = Yup.object({
    message: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.required))
      .max(
        MAX_ISSUE_MESSAGE_LENGTH,
        intl.formatMessage(messages.tooLong, {
          maxLength: MAX_ISSUE_MESSAGE_LENGTH,
        })
      ),
  });
  const saveStatus = async () => {
    if (!canComment || statusBusy) return;
    setStatusBusy(true);
    try {
      await axios.post(
        `/api/v1/issue/${issue.id}/${isOpen ? 'resolved' : 'open'}`
      );
      await onUpdate();
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setStatusBusy(false);
    }
  };
  return (
    <div className="issue-discussion card-stack">
      {issue.media?.mediaType === MediaType.TV && (
        <IssueAffectedEpisodes issue={issue} tvId={issue.media.tmdbId} />
      )}
      <section className="card-stack">
        <h3 className="media-inset-table-heading">
          {intl.formatMessage(messages.description)}
        </h3>
        <time
          className="refreshed-detail-text-muted"
          dateTime={new Date(issue.createdAt).toISOString()}
        >
          <FormattedDate value={issue.createdAt} dateStyle="medium" />{' '}
          <FormattedDate value={issue.createdAt} timeStyle="short" />
        </time>
        <div className="issue-discussion-markdown refreshed-detail-text-muted">
          <ReactMarkdown
            skipHtml
            allowedElements={['p', 'em', 'strong', 'ul', 'ol', 'li']}
          >
            {description?.message ?? ''}
          </ReactMarkdown>
        </div>
      </section>
      <section className="card-stack">
        <h3 className="media-inset-table-heading">
          {intl.formatMessage(messages.comments)}
        </h3>
        {comments.length ? (
          comments.map((comment) => (
            <IssueComment
              key={comment.id}
              comment={comment}
              isActiveUser={comment.user.id === user?.id}
              onUpdate={() => void onUpdate()}
            />
          ))
        ) : (
          <p className="refreshed-detail-text-muted">
            {intl.formatMessage(messages.noComments)}
          </p>
        )}
      </section>
      {canComment && (
        <Formik
          initialValues={{ message: '' }}
          validationSchema={schema}
          onSubmit={async (values, { resetForm }) => {
            try {
              await axios.post(`/api/v1/issue/${issue.id}/comment`, {
                message: values.message.trim(),
              });
              resetForm();
              await onUpdate();
            } catch {
              addToast(intl.formatMessage(messages.failed), {
                appearance: 'error',
                autoDismiss: true,
              });
            }
          }}
        >
          {({ isValid, isSubmitting, values, errors, touched }) => (
            <Form className="card-stack">
              <label htmlFor={inputId} className="sr-only">
                {intl.formatMessage(messages.addComment)}
              </label>
              <Field
                as="textarea"
                rows={3}
                id={inputId}
                name="message"
                className="issue-comment-input"
                placeholder={intl.formatMessage(messages.commentPlaceholder)}
                maxLength={MAX_ISSUE_MESSAGE_LENGTH}
                disabled={isSubmitting || statusBusy}
              />
              {errors.message && touched.message && (
                <p role="alert" className="issue-discussion-error">
                  {errors.message}
                </p>
              )}
              <div className="issue-discussion-actions">
                <Button
                  type="submit"
                  buttonType="warning"
                  buttonSize="sm"
                  title={intl.formatMessage(messages.addHelp)}
                  disabled={
                    !isValid ||
                    isSubmitting ||
                    statusBusy ||
                    !values.message.trim()
                  }
                  disabledReason={intl.formatMessage(messages.required)}
                >
                  <ChatBubbleOvalLeftEllipsisIcon />
                  {intl.formatMessage(messages.addComment)}
                </Button>
                <Button
                  type="button"
                  buttonType={isOpen ? 'warning' : 'success'}
                  buttonSize="sm"
                  disabled={statusBusy || isSubmitting}
                  title={intl.formatMessage(
                    isOpen ? messages.closeHelp : messages.reopenHelp
                  )}
                  onClick={() => void saveStatus()}
                >
                  {isOpen ? <CheckCircleIcon /> : <ArrowPathIcon />}
                  {intl.formatMessage(
                    isOpen ? messages.close : messages.reopen
                  )}
                </Button>
              </div>
            </Form>
          )}
        </Formik>
      )}
    </div>
  );
};

export default IssueDiscussion;
