import $ from 'jquery';
import * as d3 from 'd3';
import {
  AutoloadPage,
  addPage
} from '@ejunz/ui-default';
addPage(new AutoloadPage('tree_detail,tree_map', async () => {
    const data = UiContext.d3TreeData;
    if (!data) {
      d3.select("#d3-tree")
        .append("text")
        .attr("x", 20)
        .attr("y", 40)
        .style("fill", "#888")
        .style("font-size", "16px")
        .text("暂无树结构数据, 请先创建一个树干");
      return;
    }
    
    const dx = 80;
    const dy = 220;
  
    const svg = d3.select("#d3-tree");
    svg.selectAll("*").remove();
  
    const root = d3.hierarchy(data);
    const treeLayout = d3.tree()
    .nodeSize([dx, dy])
    .separation((a, b) => (a.parent === b.parent ? 1.2 : 2));
    treeLayout(root);

    const x0 = d3.min(root.descendants(), d => d.x);
    const x1 = d3.max(root.descendants(), d => d.x);
    const y0 = 0;
    const y1 = d3.max(root.descendants(), d => d.y);
  
    const padding = 60;
  
    const width = x1 - x0 + padding * 2;
    const height = y1 + padding * 2;
  
    svg
    .attr("viewBox", [x0 - padding, -y1 - padding, width, height])
    .attr("width", "100%")
    .attr("height", height + 100)  
    .attr("preserveAspectRatio", "xMidYMid meet");
  
    const g = svg.append("g");
  
    g.selectAll(".link")
      .data(root.links())
      .enter()
      .append("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("stroke", "#ccc")
      .attr("stroke-width", 1.5)
      .attr("d", d3.linkVertical()
        .x(d => d.x)
        .y(d => -d.y)
      );
  
    const node = g.selectAll(".node")
      .data(root.descendants())
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("transform", d => `translate(${d.x},${-d.y})`);

    const currentDocId = UiContext.ddoc?.docId;

    node.append("circle")
    .attr("r", d => d.data.docId === currentDocId ? 7 : 5)
    .attr("fill", "#4682B4")
    .attr("stroke", d => d.data.docId === currentDocId ? "#00cc66" : "none")
    .attr("stroke-width", d => d.data.docId === currentDocId ? 3 : 0);

  
    node.append("text")
    .attr("dy", "-0.8em")
    .attr("text-anchor", "middle")
    .text(d => d.data.name)
    .style("fill", d =>
      d.data.docId === currentDocId
        ? "#00ff88"
        : `hsl(210, 80%, ${Math.min(30 + d.depth * 10, 70)}%)`
    )
    .style("font-weight", d => d.data.docId === currentDocId ? "bold" : "normal")
    .style("font-size", d => d.data.docId === currentDocId ? "14px" : "13px")
    .style("cursor", "pointer")

    .on("click", (event, d) => {
        if (!d.data.url) return;

        const isNewTab = event.ctrlKey || event.metaKey || event.button === 1;
        if (isNewTab) {
        window.open(d.data.url, '_blank');
        } else {
        window.location.href = d.data.url;
        }
    })
    .on("mousedown", function(event) {
        if (event.button === 1) event.preventDefault();
    })
    .on("mouseover", function () {
        d3.select(this).style("font-weight", "bold");
    })
    .on("mouseout", function (event, d) {
      if (d.data.docId !== currentDocId) {
        d3.select(this).style("font-weight", "normal");
      }
    });
    const zoom = d3.zoom()
    .scaleExtent([0.5, 3])
    .on("zoom", event => {
      g.attr("transform", event.transform);
    });
  
  svg
    .on("wheel.zoom", (event) => {
      event.preventDefault();
    }, { passive: false })
    .call(zoom)
    .call(zoom.transform, d3.zoomIdentity.translate(padding, padding));

    if (currentDocId) {
      const currentNode = root.descendants().find(d => d.data.docId === currentDocId);
      if (currentNode) {
        const x = currentNode.x;
        const y = -currentNode.y;
        const scale = 1.5;

        const [vbX, vbY, vbWidth, vbHeight] = svg.attr('viewBox').split(/\\s+|,/).map(Number);

        const allX = root.descendants().map(d => d.x);
        const avgX = (Math.min(...allX) + Math.max(...allX)) / 2;
        const centerX = avgX;
        const centerY = vbY + vbHeight / 2;

        const translateX = centerX - x * scale;
        const translateY = centerY - y * scale;

        const transform = d3.zoomIdentity
          .translate(translateX, translateY)
          .scale(scale);

        svg.transition()
          .duration(750)
          .call(zoom.transform, transform);
      }
    }
              
  }));
  