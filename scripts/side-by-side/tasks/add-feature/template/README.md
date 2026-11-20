# csvpeek

Prints a short summary of a CSV file.

    node bin/csvpeek.js examples/plants.csv

The first line of the file is the header. A column whose every value is a number gets its min, max and mean;
other columns get the number of distinct values. Quoted fields are not supported.
