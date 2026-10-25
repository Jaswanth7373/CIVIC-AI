"""Standard pagination: ?page=<n>&page_size=<n> (max 100).

Response shape: {"count", "next", "previous", "page", "page_size", "total_pages", "results"}
"""
import math

from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response


class StandardResultsPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 100

    def get_paginated_response(self, data):
        page_size = self.get_page_size(self.request) or self.page_size
        count = self.page.paginator.count
        return Response(
            {
                "count": count,
                "next": self.get_next_link(),
                "previous": self.get_previous_link(),
                "page": self.page.number,
                "page_size": page_size,
                "total_pages": math.ceil(count / page_size) if page_size else 1,
                "results": data,
            }
        )

    def get_paginated_response_schema(self, schema):
        return super().get_paginated_response_schema(schema)
