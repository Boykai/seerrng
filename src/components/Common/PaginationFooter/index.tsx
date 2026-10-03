import Button from '@app/components/Common/Button';
import { CompactSelect } from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.PaginationFooter', {
  pagination: 'Pagination',
  resultsPerPage: 'Results Per Page',
  page: 'Page {page} of {pages}',
});

interface PaginationFooterProps {
  defaultPageSize?: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
}

const PaginationFooter = ({
  defaultPageSize = 10,
  page,
  pageSize,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
}: PaginationFooterProps) => {
  const intl = useIntl();
  const normalizedTotalPages = Math.max(totalPages, 1);
  const pageSizeSelectOptions = pageSizeOptions.map((size) => ({
    label: String(size),
    value: String(size),
  }));

  return (
    <nav
      className="pagination-footer"
      aria-label={intl.formatMessage(messages.pagination)}
    >
      <CompactSelect
        label={intl.formatMessage(messages.resultsPerPage)}
        value={String(pageSize)}
        options={pageSizeSelectOptions}
        onChange={(value) => onPageSizeChange(Number(value))}
        className="pagination-footer-page-size"
        defaultValue={String(defaultPageSize)}
      />
      <span className="pagination-footer-page">
        {intl.formatMessage(messages.page, {
          page,
          pages: normalizedTotalPages,
        })}
      </span>
      <div className="pagination-footer-actions">
        <Button
          disabled={page <= 1}
          buttonType="success"
          buttonSize="sm"
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeftIcon className="app-navigation-icon" aria-hidden="true" />
          {intl.formatMessage(globalMessages.previous)}
        </Button>
        <Button
          disabled={page >= normalizedTotalPages}
          buttonType="success"
          buttonSize="sm"
          onClick={() => onPageChange(page + 1)}
        >
          {intl.formatMessage(globalMessages.next)}
          <ChevronRightIcon
            className="app-navigation-icon"
            aria-hidden="true"
          />
        </Button>
      </div>
    </nav>
  );
};

export default PaginationFooter;
